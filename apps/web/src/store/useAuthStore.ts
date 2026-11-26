import { create } from 'zustand';
import {
  DEFAULT_ARGON2_KDF_PARAMS,
  mapUserDtoToDomain,
  peerAvatarColorIndex,
  type AuthCustodyUpdateResponse,
  type AuthResponse,
  type QrPairSessionDto,
  type SessionDto,
  type TwoFactorStatusDto,
  type UserProfile,
} from '@gpui-telegram/protocol';
import {
  TwoFactorChallengeError,
  broadcastSync,
  getClientAdapter,
  getServerAdapter,
  indexedDbCache,
  switchClientAdapterMode,
} from '../adapters';
import {
  clearE2eeCacheForAccount,
  generateIdentityKeyPair,
  toPublishPreKeysRequest,
} from '../services/e2eeClient';
import { deriveSplitKeyV2, generateRandomSaltB64 } from '../services/splitKeyCrypto';

export const MAX_STORED_ACCOUNTS = 6;
const AUTH_STORAGE_KEY = 'gpui_tg_auth_v1';
const ACTIVE_TOKEN_MIRROR_KEY = 'gpui_tg_active_token';
const ACTIVE_CHAT_SESSION_KEY = 'gpui_tg_active_chat_id';
const FRAME0_SNAPSHOT_PREFIX = 'gpui_tg_frame0_v1:';

function purgeAccountClientCaches(accountId?: string | null, wipeAll = false): void {
  try {
    if (typeof localStorage !== 'undefined') {
      if (wipeAll || !accountId) {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(FRAME0_SNAPSHOT_PREFIX)) {
            toRemove.push(k);
          }
        }
        for (const k of toRemove) {
          localStorage.removeItem(k);
        }
      } else {
        localStorage.removeItem(`${FRAME0_SNAPSHOT_PREFIX}${accountId}`);
      }
    }
  } catch {
    // Ignore storage error
  }

  if (wipeAll || !accountId) {
    clearE2eeCacheForAccount();
    void indexedDbCache.clearAll().catch(() => undefined);
  } else {
    clearE2eeCacheForAccount(accountId);
    void indexedDbCache.clearAccountData(accountId).catch(() => undefined);
  }
}

export interface AlipayAuthSession {
  session_id: string;
  qr_url: string;
  svg: string;
  expires_at_ms: number;
  status?: string;
  auth?: AuthResponse;
}

export interface StoredAccountSession {
  accountId: string;
  userId: number;
  token: string;
  sessionId: string;
  expiresAtMs: number;
  user: UserProfile;
  adapterMode: 'server';
  serverUrl: string;
}

interface PersistedAuthEnvelope {
  accounts: StoredAccountSession[];
  activeAccountId: string | null;
  adapterMode: 'server';
  serverUrl: string;
  passcodeHash: string | null;
  isLocked: boolean;
}

export interface ServerHealthSnapshot {
  ok?: boolean;
  status: 'unknown' | 'checking' | 'online' | 'offline';
  version?: string;
  server?: string;
  mode?: string;
  latencyMs?: number;
  error?: string;
}

export interface PasskeySummaryItem {
  cred_id: string;
  label: string;
  created_at_ms: number;
  last_used_ms?: number | null;
}

export interface AuthState {
  accounts: StoredAccountSession[];
  activeAccountId: string | null;
  currentUser: UserProfile | null;
  token: string | null;
  isAuthenticated: boolean;
  isAddingAccount: boolean;

  adapterMode: 'server';
  serverUrl: string;
  serverHealth: ServerHealthSnapshot;

  passcodeHash: string | null;
  isLocked: boolean;
  passcodeError: string | null;

  isLoading: boolean;
  error: string | null;
  phoneCodeHash: string | null;
  pendingPhone: string | null;
  requires2fa: boolean;
  twoFaChallengeToken: string | null;
  twoFaHint: string | null;
  twoFaStatus: TwoFactorStatusDto | null;
  qrSession: QrPairSessionDto | null;
  emailCodeHash: string | null;
  pendingEmail: string | null;
  alipaySession: AlipayAuthSession | null;
  activeSessions: SessionDto[];

  hydrateAuth: () => Promise<void>;
  probeServerHealth: (overrideUrl?: string) => Promise<ServerHealthSnapshot>;
  clearError: () => void;
  setServerUrl: (url: string) => void;

  sendPhoneCode: (phone: string) => Promise<{ phoneCodeHash: string }>;
  verifyPhoneCode: (params: {
    phone?: string;
    code: string;
    phoneCodeHash?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
  }) => Promise<{ authenticated: boolean; requires2fa?: boolean }>;
  verify2fa: (password: string) => Promise<UserProfile>;
  refresh2faStatus: () => Promise<TwoFactorStatusDto>;
  set2faPassword: (req: {
    currentPassword?: string;
    newPassword: string;
    hint?: string;
    recoveryEmail?: string;
  }) => Promise<TwoFactorStatusDto>;
  disable2faPassword: (currentPassword?: string) => Promise<{ ok: boolean }>;

  startQrPairing: (deviceName?: string) => Promise<QrPairSessionDto>;
  pollQrPairing: (pairId?: string) => Promise<QrPairSessionDto | null>;

  loginPassword: (
    username: string,
    password: string,
    twoFaPassword?: string,
  ) => Promise<{ authenticated: boolean; requires2fa?: boolean }>;
  registerPassword: (req: {
    username: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }) => Promise<UserProfile>;
  upgradeSplitKey: (oldPassword: string) => Promise<AuthCustodyUpdateResponse>;
  changePassword: (oldSecret: string, newPassword: string) => Promise<AuthCustodyUpdateResponse>;

  sendEmailCode: (email: string) => Promise<{ emailCodeHash: string }>;
  verifyEmailCode: (params: {
    email?: string;
    code: string;
    emailCodeHash?: string;
  }) => Promise<{ authenticated: boolean; requires2fa?: boolean }>;
  registerEmail: (params: {
    email?: string;
    code: string;
    username: string;
    password: string;
    firstName?: string;
    lastName?: string;
    emailCodeHash?: string;
  }) => Promise<UserProfile>;

  startAlipay: () => Promise<AlipayAuthSession>;
  pollAlipay: (sessionId?: string) => Promise<AlipayAuthSession | null>;

  registerPasskey: (label?: string) => Promise<boolean>;
  loginPasskey: (username?: string) => Promise<UserProfile>;
  listPasskeys: () => Promise<PasskeySummaryItem[]>;
  deletePasskey: (credId: string) => Promise<void>;

  switchAccount: (accountId: string) => Promise<void>;
  addAccountFlow: () => void;
  cancelAddAccountFlow: () => void;
  removeAccount: (accountId: string) => Promise<void>;
  deleteAccount: () => Promise<void>;
  logout: (logoutAll?: boolean) => Promise<void>;

  loadSessions: () => Promise<SessionDto[]>;
  revokeSession: (sessionId: string) => Promise<void>;
  revokeOtherSessions: () => Promise<number>;

  setPasscode: (passcode: string) => Promise<void>;
  clearPasscode: (currentPasscode?: string) => Promise<boolean>;
  lockApp: () => void;
  unlockApp: (passcode: string) => Promise<boolean>;
}

function clearSavedActiveChatId(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(ACTIVE_CHAT_SESSION_KEY);
    }
  } catch {
    // Ignore sessionStorage restrictions
  }
}

function authResponseToUserProfile(authRes: AuthResponse): UserProfile {
  if (authRes.user) {
    return mapUserDtoToDomain(authRes.user);
  }
  const userId = Number(authRes.user_id);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('服务器未返回有效的用户 ID');
  }
  return {
    userId,
    user_id: userId,
    username: authRes.username,
    firstName: authRes.first_name ?? authRes.username ?? `User ${userId}`,
    first_name: authRes.first_name ?? authRes.username ?? `User ${userId}`,
    lastName: authRes.last_name,
    last_name: authRes.last_name,
    isBot: false,
    isVerified: false,
    isPremium: false,
    status: 'online',
    colorIndex: peerAvatarColorIndex(userId),
  };
}

async function hashPasscode(rawPasscode: string): Promise<string> {
  const normalized = `gpui_tg_passcode_salt_v1:${rawPasscode}`;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(normalized),
    );
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16)}`;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function arrayBufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function loadPersistedAuth(): PersistedAuthEnvelope {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedAuthEnvelope>;
        const rawAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
        const accounts: StoredAccountSession[] = rawAccounts
          .filter((a) => a && typeof a.token === 'string' && a.token.trim().length > 0)
          .map((a) => ({
            ...a,
            adapterMode: 'server' as const,
          }));
        return {
          accounts,
          activeAccountId: parsed.activeAccountId ?? accounts[0]?.accountId ?? null,
          adapterMode: 'server',
          serverUrl: parsed.serverUrl ?? '',
          passcodeHash: parsed.passcodeHash ?? null,
          isLocked: Boolean(parsed.passcodeHash && parsed.isLocked),
        };
      }
    }
  } catch {
    // Ignore malformed storage
  }
  return {
    accounts: [],
    activeAccountId: null,
    adapterMode: 'server',
    serverUrl: '',
    passcodeHash: null,
    isLocked: false,
  };
}

function persistAuthEnvelope(
  state: Pick<
    AuthState,
    'accounts' | 'activeAccountId' | 'serverUrl' | 'passcodeHash' | 'isLocked' | 'token'
  >,
): void {
  try {
    if (typeof localStorage !== 'undefined') {
      const env: PersistedAuthEnvelope = {
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        adapterMode: 'server',
        serverUrl: state.serverUrl,
        passcodeHash: state.passcodeHash,
        isLocked: state.isLocked,
      };
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(env));
      if (state.token) {
        localStorage.setItem(ACTIVE_TOKEN_MIRROR_KEY, JSON.stringify({ token: state.token }));
      } else {
        localStorage.removeItem(ACTIVE_TOKEN_MIRROR_KEY);
      }
    }
  } catch {
    // Ignore quota error
  }
}

const bootAuth = loadPersistedAuth();

function sanitizeServerUrlOverride(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback)) {
      return parsed.origin;
    }
  } catch {
    // Reject malformed URLs
  }
  return undefined;
}

function detectInitialServerUrlOverride(hasAuthenticatedAccount: boolean): string | undefined {
  const envDefaultServer = sanitizeServerUrlOverride(
    (import.meta as ImportMeta & { env?: { VITE_DEFAULT_SERVER_URL?: string } }).env
      ?.VITE_DEFAULT_SERVER_URL,
  );
  if (typeof window === 'undefined') {
    return envDefaultServer;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const hasQueryServer = params.has('server') || params.has('api');
    const qServer = sanitizeServerUrlOverride(params.get('server') || params.get('api'));
    if (hasQueryServer) {
      // Strip ?server=/?api= from the address bar so it cannot persist or be replayed on reload
      try {
        params.delete('server');
        params.delete('api');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
        window.history.replaceState(window.history.state, '', nextUrl);
      } catch {
        // Ignore history API restriction
      }
      // STRICT SECURITY INVARIANT (F-01): Never override an already-authenticated account's serverUrl
      // from URL query parameters, preventing 1-click Bearer/WS token exfiltration.
      if (!hasAuthenticatedAccount && qServer) {
        return qServer;
      }
    }
    if (envDefaultServer && !bootAuth.serverUrl) {
      return envDefaultServer;
    }
    const host = window.location.hostname.toLowerCase();
    const isKnownStaticHost =
      host.endsWith('.github.io') ||
      host.endsWith('.pages.dev') ||
      host.endsWith('.netlify.app') ||
      host.endsWith('.vercel.app');
    if (isKnownStaticHost && !bootAuth.serverUrl) {
      return 'https://web.ombhrum.com';
    }
  } catch {
    // Ignore URL parse error
  }
  return undefined;
}

const initialActiveAccount =
  bootAuth.accounts.find((a) => a.accountId === bootAuth.activeAccountId) ??
  bootAuth.accounts[0] ??
  null;

const bootServerOverride = detectInitialServerUrlOverride(Boolean(initialActiveAccount?.token));
const initialServerUrl = initialActiveAccount?.token
  ? initialActiveAccount.serverUrl || bootAuth.serverUrl
  : bootServerOverride ?? bootAuth.serverUrl;

if (initialActiveAccount) {
  getServerAdapter().configure({
    serverUrl: initialActiveAccount.serverUrl || bootAuth.serverUrl,
    token: initialActiveAccount.token,
    accountId: initialActiveAccount.accountId,
    userId: initialActiveAccount.userId ?? initialActiveAccount.user.userId,
  });
} else {
  getServerAdapter().configure({ serverUrl: initialServerUrl });
}

let onAccountActivatedHook: ((accountId: string, user: UserProfile) => void) | null = null;
let onAuthClearedHook: (() => void) | null = null;

export function registerAccountActivatedHook(
  hook: ((accountId: string, user: UserProfile) => void) | null,
): void {
  onAccountActivatedHook = hook;
}

export function registerAuthClearedHook(hook: (() => void) | null): void {
  onAuthClearedHook = hook;
}

export const useAuthStore = create<AuthState>((set, get) => {
  const commitAuthSuccess = async (authRes: AuthResponse): Promise<UserProfile> => {
    const user = authResponseToUserProfile(authRes);
    const accountId = String(user.userId);
    const prevAccountId = get().activeAccountId;
    const serverUrl = get().serverUrl;

    if (prevAccountId && prevAccountId !== accountId) {
      clearSavedActiveChatId();
      purgeAccountClientCaches(prevAccountId, false);
      onAuthClearedHook?.();
    }

    const entry: StoredAccountSession = {
      accountId,
      userId: user.userId,
      token: authRes.token,
      sessionId: authRes.session_id,
      expiresAtMs: authRes.expires_at_ms ?? Date.now() + 30 * 86_400_000,
      user,
      adapterMode: 'server',
      serverUrl,
    };

    const existingOthers = get().accounts.filter((a) => a.accountId !== accountId);
    const accounts = [entry, ...existingOthers].slice(0, MAX_STORED_ACCOUNTS);

    await switchClientAdapterMode('server', {
      serverUrl,
      token: authRes.token,
      accountId,
      userId: user.userId,
    });

    set({
      accounts,
      activeAccountId: accountId,
      currentUser: user,
      token: authRes.token,
      isAuthenticated: true,
      isAddingAccount: false,
      isLoading: false,
      error: null,
      requires2fa: false,
      twoFaChallengeToken: null,
      twoFaHint: null,
    });

    persistAuthEnvelope(get());

    const adapter = getClientAdapter();
    await adapter.connect(authRes.token).catch(() => undefined);

    void generateIdentityKeyPair(user.userId)
      .then((identity) => adapter.publishPreKeys(toPublishPreKeysRequest(identity, 'Fabushi Web (Browser)')))
      .catch(() => undefined);

    broadcastSync.publish({ kind: 'auth_switched', activeAccountId: accountId });
    onAccountActivatedHook?.(accountId, user);
    return user;
  };

  return {
    accounts: bootAuth.accounts,
    activeAccountId: initialActiveAccount?.accountId ?? null,
    currentUser: initialActiveAccount?.user ?? null,
    token: initialActiveAccount?.token ?? null,
    isAuthenticated: Boolean(initialActiveAccount?.token),
    isAddingAccount: false,

    adapterMode: 'server',
    serverUrl: initialActiveAccount?.token
      ? initialActiveAccount.serverUrl || bootAuth.serverUrl
      : initialServerUrl,
    serverHealth: { status: 'unknown' },

    passcodeHash: bootAuth.passcodeHash,
    isLocked: bootAuth.isLocked,
    passcodeError: null,

    isLoading: false,
    error: null,
    phoneCodeHash: null,
    pendingPhone: null,
    requires2fa: false,
    twoFaChallengeToken: null,
    twoFaHint: null,
    twoFaStatus: null,
    qrSession: null,
    emailCodeHash: null,
    pendingEmail: null,
    alipaySession: null,
    activeSessions: [],

    probeServerHealth: async (overrideUrl) => {
      const targetUrl = overrideUrl !== undefined ? overrideUrl : get().serverUrl;
      set({ serverHealth: { ok: false, status: 'checking' } });
      const res = await getServerAdapter().probeServerHealth(targetUrl);
      const snapshot: ServerHealthSnapshot = res.ok
        ? {
            ok: true,
            status: 'online',
            version: res.version,
            server: res.server,
            mode: res.mode,
            latencyMs: res.latencyMs,
          }
        : {
            ok: false,
            status: 'offline',
            latencyMs: res.latencyMs,
            error: res.error ?? '服务器无法连接',
          };
      set({ serverHealth: snapshot });
      return snapshot;
    },

    hydrateAuth: async () => {
      const loaded = loadPersistedAuth();
      const active =
        loaded.accounts.find((a) => a.accountId === loaded.activeAccountId) ??
        loaded.accounts[0] ??
        null;
      const serverOverride = detectInitialServerUrlOverride(Boolean(active?.token));
      const effectiveServerUrl = serverOverride ?? loaded.serverUrl;

      if (!active) {
        await switchClientAdapterMode('server', { serverUrl: effectiveServerUrl });
        set({
          accounts: [],
          activeAccountId: null,
          currentUser: null,
          token: null,
          isAuthenticated: false,
          adapterMode: 'server',
          serverUrl: effectiveServerUrl,
          passcodeHash: null,
          isLocked: false,
        });
        void get().probeServerHealth(effectiveServerUrl);
        return;
      }

      // STRICT SECURITY INVARIANT (F-01): Always transmit the stored session token strictly
      // to the serverUrl bound to that account, never to a URL query-param override.
      const targetServerUrl = active.serverUrl || loaded.serverUrl;
      const adapter = await switchClientAdapterMode('server', {
        serverUrl: targetServerUrl,
        token: active.token,
        accountId: active.accountId,
        userId: active.userId ?? active.user.userId,
      });

      set({
        accounts: loaded.accounts,
        activeAccountId: active.accountId,
        currentUser: active.user,
        token: active.token,
        isAuthenticated: true,
        adapterMode: 'server',
        serverUrl: targetServerUrl,
        passcodeHash: loaded.passcodeHash,
        isLocked: loaded.isLocked,
      });

      try {
        await adapter.connect(active.token);
        const refreshedMe = await adapter.getMe();
        const updatedAccounts = get().accounts.map((acc) =>
          acc.accountId === active.accountId ? { ...acc, user: refreshedMe } : acc,
        );
        set({
          currentUser: refreshedMe,
          accounts: updatedAccounts,
          serverHealth: { status: 'online' },
        });
        persistAuthEnvelope(get());
        onAccountActivatedHook?.(active.accountId, refreshedMe);
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        const isAuthRejected =
          status === 401 ||
          status === 403 ||
          msg.includes('unauthorized') ||
          msg.includes('invalid or expired') ||
          msg.includes('session revoked');
        if (isAuthRejected) {
          clearSavedActiveChatId();
          purgeAccountClientCaches(active.accountId, false);
          onAuthClearedHook?.();
          const remaining = get().accounts.filter((a) => a.accountId !== active.accountId);
          set({
            accounts: remaining,
            activeAccountId: null,
            currentUser: null,
            token: null,
            isAuthenticated: false,
            passcodeHash: remaining.length === 0 ? null : get().passcodeHash,
            isLocked: false,
            error: '登录会话已失效，请重新登录。',
          });
          persistAuthEnvelope(get());
          void get().probeServerHealth(targetServerUrl);
          return;
        }
        onAccountActivatedHook?.(active.accountId, active.user);
      }
    },

    clearError: () => set({ error: null, passcodeError: null }),

    setServerUrl: (url) => {
      const clean = url.trim().replace(/\/+$/, '');
      getServerAdapter().configure({ serverUrl: clean });
      set({ serverUrl: clean, serverHealth: { status: 'unknown' } });
      persistAuthEnvelope(get());
    },

    sendPhoneCode: async (phone) => {
      set({ isLoading: true, error: null, requires2fa: false });
      try {
        const res = await getClientAdapter().sendPhoneCode(phone);
        set({
          isLoading: false,
          pendingPhone: phone,
          phoneCodeHash: res.phone_code_hash,
        });
        return { phoneCodeHash: res.phone_code_hash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    verifyPhoneCode: async (params) => {
      const phone = params.phone ?? get().pendingPhone ?? '';
      const phone_code_hash = params.phoneCodeHash ?? get().phoneCodeHash ?? undefined;
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter().verifyPhoneCode({
          phone,
          phone_code_hash,
          code: params.code,
          password: params.password,
          first_name: params.firstName,
          last_name: params.lastName,
        });
        if ('requires_2fa' in res && res.requires_2fa) {
          set({
            isLoading: false,
            requires2fa: true,
            twoFaChallengeToken: res.challenge_token,
            twoFaHint: res.hint ?? null,
          });
          return { authenticated: false, requires2fa: true };
        }
        await commitAuthSuccess(res as AuthResponse);
        return { authenticated: true };
      } catch (err) {
        if (err instanceof TwoFactorChallengeError) {
          set({
            isLoading: false,
            requires2fa: true,
            twoFaChallengeToken: err.challengeToken,
            twoFaHint: err.hint ?? null,
          });
          return { authenticated: false, requires2fa: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    verify2fa: async (password) => {
      const challenge_token = get().twoFaChallengeToken ?? '';
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter().verify2fa({
          challenge_token,
          password,
        });
        return await commitAuthSuccess(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    refresh2faStatus: async () => {
      const status = await getClientAdapter().get2faStatus();
      set({ twoFaStatus: status });
      return status;
    },

    set2faPassword: async (req) => {
      const status = await getClientAdapter().set2faPassword({
        current_password: req.currentPassword,
        new_password: req.newPassword,
        hint: req.hint,
        recovery_email: req.recoveryEmail,
      });
      set({ twoFaStatus: status });
      return status;
    },

    disable2faPassword: async (currentPassword) => {
      const res = await getClientAdapter().disable2faPassword(currentPassword);
      set({ twoFaStatus: { enabled: false, has_password: false } });
      return res;
    },

    startQrPairing: async (deviceName = 'Fabushi Web') => {
      set({ isLoading: true, error: null });
      try {
        const session = await getClientAdapter().initQrPairing(deviceName);
        set({ isLoading: false, qrSession: session });
        return session;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    pollQrPairing: async (pairId) => {
      const targetId = pairId ?? get().qrSession?.pair_id;
      if (!targetId) return null;
      const session = await getClientAdapter().pollQrPairing(targetId);
      set({ qrSession: session });
      if (session.status === 'approved' && (session.session || (session.token && session.user))) {
        const auth: AuthResponse = session.session ?? {
          user_id: session.user!.user_id,
          username: session.user!.username ?? `user${session.user!.user_id}`,
          session_id: `qr_${session.pair_id}`,
          token: session.token!,
          user: session.user,
        };
        await commitAuthSuccess(auth);
      }
      return session;
    },

    loginPassword: async (username, password, twoFaPassword) => {
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter().loginPassword(username, password, twoFaPassword);
        await commitAuthSuccess(res);
        return { authenticated: true };
      } catch (err) {
        if (err instanceof TwoFactorChallengeError) {
          set({
            isLoading: false,
            requires2fa: true,
            twoFaChallengeToken: err.challengeToken,
            twoFaHint: err.hint ?? null,
            error: null,
          });
          return { authenticated: false, requires2fa: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    registerPassword: async (req) => {
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter().registerPassword({
          username: req.username,
          password: req.password,
          first_name: req.firstName || req.username,
          last_name: req.lastName,
        });
        return await commitAuthSuccess(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    upgradeSplitKey: async (oldPassword) => {
      const salt = generateRandomSaltB64(16);
      const derived = await deriveSplitKeyV2(oldPassword, salt, DEFAULT_ARGON2_KDF_PARAMS);
      return getServerAdapter().upgradeSplitKey({
        old_password: oldPassword,
        auth_salt_b64: salt,
        auth_verifier_b64: derived.authVerifierB64,
        kdf_params: derived.kdfParams,
      });
    },

    changePassword: async (oldSecret, newPassword) => {
      const user = get().currentUser;
      const server = getServerAdapter();
      let resolvedOldSecret = oldSecret;
      if (user?.username) {
        try {
          const kdf = await server.getKdfParams(user.username);
          if (kdf.auth_version === 2 && kdf.auth_salt_b64) {
            const oldDerived = await deriveSplitKeyV2(
              oldSecret,
              kdf.auth_salt_b64,
              kdf.kdf_params ?? DEFAULT_ARGON2_KDF_PARAMS,
            );
            resolvedOldSecret = oldDerived.authVerifierB64;
          }
        } catch {
          // Fall back to direct oldSecret if KDF probe fails
        }
      }
      const newSalt = generateRandomSaltB64(16);
      const nextDerived = await deriveSplitKeyV2(newPassword, newSalt, DEFAULT_ARGON2_KDF_PARAMS);
      return server.changePassword({
        old_secret: resolvedOldSecret,
        auth_version: 2,
        new_auth_salt_b64: newSalt,
        new_auth_verifier_b64: nextDerived.authVerifierB64,
        new_kdf_params: nextDerived.kdfParams,
      });
    },

    sendEmailCode: async (email) => {
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter().sendEmailCode(email);
        set({
          isLoading: false,
          pendingEmail: email,
          emailCodeHash: res.email_code_hash,
        });
        return { emailCodeHash: res.email_code_hash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    verifyEmailCode: async (params) => {
      const email = params.email ?? get().pendingEmail ?? '';
      const email_code_hash = params.emailCodeHash ?? get().emailCodeHash ?? undefined;
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter().verifyEmailCode({
          email,
          code: params.code,
          email_code_hash,
        });
        await commitAuthSuccess(res);
        return { authenticated: true };
      } catch (err) {
        if (err instanceof TwoFactorChallengeError) {
          set({
            isLoading: false,
            requires2fa: true,
            twoFaChallengeToken: err.challengeToken,
            twoFaHint: err.hint ?? null,
            error: null,
          });
          return { authenticated: false, requires2fa: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    registerEmail: async (params) => {
      const email = params.email ?? get().pendingEmail ?? '';
      const email_code_hash = params.emailCodeHash ?? get().emailCodeHash ?? undefined;
      set({ isLoading: true, error: null });
      try {
        const res = await getServerAdapter().emailRegister({
          email,
          code: params.code,
          username: params.username,
          password: params.password,
          first_name: params.firstName,
          last_name: params.lastName,
          email_code_hash,
        });
        return await commitAuthSuccess(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    startAlipay: async () => {
      set({ isLoading: true, error: null });
      try {
        const session = await getClientAdapter().startAlipayAuth();
        set({ isLoading: false, alipaySession: session });
        return session;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    pollAlipay: async (sessionId) => {
      const base = get().alipaySession;
      const targetId = sessionId ?? base?.session_id;
      if (!targetId) return null;
      const polled = await getClientAdapter().pollAlipayAuth(targetId);
      const next: AlipayAuthSession = {
        session_id: targetId,
        qr_url: base?.qr_url ?? '',
        svg: base?.svg ?? '',
        expires_at_ms: base?.expires_at_ms ?? Date.now() + 180_000,
        status: polled.status,
        auth: polled.auth,
      };
      set({ alipaySession: next });
      if ((polled.status === 'confirmed' || polled.status === 'completed') && polled.auth) {
        await commitAuthSuccess(polled.auth);
      }
      return next;
    },

    registerPasskey: async (label = 'Fabushi Web Passkey') => {
      const server = getServerAdapter();
      const user = get().currentUser;
      if (!user) {
        throw new Error('请先登录后再绑定通行密钥 (Passkey)');
      }
      if (
        typeof window === 'undefined' ||
        typeof window.PublicKeyCredential === 'undefined' ||
        !navigator.credentials ||
        typeof navigator.credentials.create !== 'function'
      ) {
        throw new Error('当前浏览器或环境不支持 WebAuthn Passkey（需要 HTTPS 或 localhost 安全上下文）');
      }

      const opts = await server.getPasskeyRegisterOptions();
      const userIdBytes = opts.user?.id
        ? base64ToUint8Array(opts.user.id)
        : new TextEncoder().encode(String(user.userId));

      const created = (await navigator.credentials.create({
        publicKey: {
          challenge: base64ToUint8Array(opts.challenge) as BufferSource,
          rp: {
            name: opts.rp?.name || 'Fabushi Web',
            id: opts.rp?.id || opts.rp_id || window.location.hostname || 'localhost',
          },
          user: {
            id: userIdBytes as BufferSource,
            name: opts.user?.name || user.username || `user_${user.userId}`,
            displayName:
              opts.user?.displayName ||
              `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
              user.username ||
              `User ${user.userId}`,
          },
          pubKeyCredParams: opts.pubKeyCredParams ?? [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -8 },
            { type: 'public-key', alg: -257 },
          ],
          excludeCredentials: (opts.excludeCredentials ?? []).map((c) => ({
            type: 'public-key' as const,
            id: base64ToUint8Array(c.id) as BufferSource,
          })),
          authenticatorSelection: {
            userVerification: 'preferred',
            residentKey: 'preferred',
          },
          timeout: opts.timeout ?? 60_000,
        },
      })) as PublicKeyCredential | null;

      if (!created) {
        throw new Error('已取消创建通行密钥');
      }

      const credId = created.id || arrayBufferToBase64Url(created.rawId);
      const resp = created.response as AuthenticatorAttestationResponse;
      const attestationObject = arrayBufferToBase64Url(resp.attestationObject);
      const clientDataJSON = arrayBufferToBase64Url(resp.clientDataJSON);
      let publicKeyB64: string | undefined;
      if (typeof resp.getPublicKey === 'function') {
        const pk = resp.getPublicKey();
        if (pk) publicKeyB64 = arrayBufferToBase64Url(pk);
      }

      const res = await server.registerPasskey({
        challenge_id: opts.challenge_id,
        cred_id: credId,
        label,
        attestationObject,
        clientDataJSON,
        public_key_b64: publicKeyB64,
      });
      return Boolean(res.cred_id);
    },

    loginPasskey: async (username) => {
      set({ isLoading: true, error: null });
      try {
        if (
          typeof window === 'undefined' ||
          typeof window.PublicKeyCredential === 'undefined' ||
          !navigator.credentials ||
          typeof navigator.credentials.get !== 'function'
        ) {
          throw new Error('当前浏览器不支持 WebAuthn 通行密钥，请使用 HTTPS 或切换其他登录方式');
        }

        const server = getServerAdapter();
        const opts = await server.getPasskeyChallenge(username);
        const allowCredentials =
          opts.allowCredentials && opts.allowCredentials.length > 0
            ? opts.allowCredentials.map((c) => ({
                type: 'public-key' as const,
                id: base64ToUint8Array(c.id) as BufferSource,
              }))
            : undefined;

        const assertion = (await navigator.credentials.get({
          publicKey: {
            challenge: base64ToUint8Array(opts.challenge) as BufferSource,
            rpId: opts.rp_id || window.location.hostname || 'localhost',
            allowCredentials,
            userVerification: 'preferred',
            timeout: opts.timeout ?? 60_000,
          },
        })) as PublicKeyCredential | null;

        if (!assertion) {
          throw new Error('未获取到通行密钥凭证');
        }

        const credentialId = assertion.id || arrayBufferToBase64Url(assertion.rawId);
        const resp = assertion.response as AuthenticatorAssertionResponse;
        const auth = await server.verifyPasskey({
          challenge_id: opts.challenge_id,
          credential_id: credentialId,
          clientDataJSON: arrayBufferToBase64Url(resp.clientDataJSON),
          authenticatorData: arrayBufferToBase64Url(resp.authenticatorData),
          signature: arrayBufferToBase64Url(resp.signature),
          device_name: 'Fabushi Web Passkey',
        });
        return await commitAuthSuccess(auth);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    listPasskeys: () => getServerAdapter().listPasskeys(),

    deletePasskey: (credId) => getServerAdapter().deletePasskey(credId),

    switchAccount: async (accountId) => {
      const target = get().accounts.find((a) => a.accountId === accountId);
      if (!target) return;

      const prevAccountId = get().activeAccountId;
      if (prevAccountId === accountId) return;
      clearSavedActiveChatId();
      if (prevAccountId && prevAccountId !== accountId) {
        purgeAccountClientCaches(prevAccountId, false);
      }
      onAuthClearedHook?.();
      await getClientAdapter().disconnect().catch(() => undefined);

      const adapter = await switchClientAdapterMode('server', {
        serverUrl: target.serverUrl || get().serverUrl,
        token: target.token,
        accountId: target.accountId,
        userId: target.userId ?? target.user.userId,
      });

      set({
        activeAccountId: target.accountId,
        currentUser: target.user,
        token: target.token,
        isAuthenticated: true,
        isAddingAccount: false,
        adapterMode: 'server',
        serverUrl: target.serverUrl || get().serverUrl,
        error: null,
      });

      persistAuthEnvelope(get());
      await adapter.connect(target.token).catch(() => undefined);
      broadcastSync.publish({ kind: 'auth_switched', activeAccountId: target.accountId });
      onAccountActivatedHook?.(target.accountId, target.user);
    },

    addAccountFlow: () => {
      set({
        isAddingAccount: true,
        error: null,
        requires2fa: false,
        twoFaChallengeToken: null,
      });
    },

    cancelAddAccountFlow: () => {
      set({ isAddingAccount: false, error: null });
    },

    removeAccount: async (accountId) => {
      const remaining = get().accounts.filter((a) => a.accountId !== accountId);
      if (get().activeAccountId === accountId) {
        if (remaining.length > 0) {
          set({ accounts: remaining });
          await get().switchAccount(remaining[0]!.accountId);
          return;
        }
        await get().logout(true);
        return;
      }
      purgeAccountClientCaches(accountId, false);
      set({ accounts: remaining });
      persistAuthEnvelope(get());
    },

    deleteAccount: async () => {
      const currentId = get().activeAccountId;
      await getServerAdapter().deleteAccount();
      clearSavedActiveChatId();
      const remaining = get().accounts.filter((a) => a.accountId !== currentId);
      purgeAccountClientCaches(currentId, remaining.length === 0);
      onAuthClearedHook?.();
      set({
        accounts: remaining,
        activeAccountId: null,
        currentUser: null,
        token: null,
        isAuthenticated: false,
        isAddingAccount: false,
        passcodeHash: remaining.length === 0 ? null : get().passcodeHash,
        isLocked: false,
        passcodeError: null,
        requires2fa: false,
        twoFaChallengeToken: null,
        qrSession: null,
        alipaySession: null,
      });
      persistAuthEnvelope(get());
      broadcastSync.publish({ kind: 'auth_switched', activeAccountId: null });
    },

    logout: async (logoutAll = false) => {
      const currentId = get().activeAccountId;
      clearSavedActiveChatId();
      await getClientAdapter().logout().catch(() => undefined);

      const remaining = logoutAll
        ? []
        : get().accounts.filter((a) => a.accountId !== currentId);

      if (remaining.length > 0 && !logoutAll) {
        purgeAccountClientCaches(currentId, false);
        set({ accounts: remaining });
        await get().switchAccount(remaining[0]!.accountId);
        return;
      }

      purgeAccountClientCaches(currentId, true);
      onAuthClearedHook?.();
      set({
        accounts: [],
        activeAccountId: null,
        currentUser: null,
        token: null,
        isAuthenticated: false,
        isAddingAccount: false,
        passcodeHash: null,
        isLocked: false,
        passcodeError: null,
        requires2fa: false,
        twoFaChallengeToken: null,
        qrSession: null,
        alipaySession: null,
      });
      persistAuthEnvelope(get());
      broadcastSync.publish({ kind: 'auth_switched', activeAccountId: null });
    },

    loadSessions: async () => {
      const sessions = await getClientAdapter().listSessions();
      set({ activeSessions: sessions });
      return sessions;
    },

    revokeSession: async (sessionId) => {
      await getClientAdapter().revokeSession(sessionId);
      await get().loadSessions();
    },

    revokeOtherSessions: async () => {
      const count = await getClientAdapter().revokeOtherSessions();
      await get().loadSessions();
      return count;
    },

    setPasscode: async (passcode) => {
      const trimmed = passcode.trim();
      if (!trimmed) return;
      const hash = await hashPasscode(trimmed);
      set({ passcodeHash: hash, passcodeError: null });
      persistAuthEnvelope(get());
    },

    clearPasscode: async (currentPasscode) => {
      const existing = get().passcodeHash;
      if (existing && currentPasscode !== undefined) {
        const check = await hashPasscode(currentPasscode.trim());
        if (check !== existing) {
          set({ passcodeError: 'Incorrect passcode' });
          return false;
        }
      }
      set({ passcodeHash: null, isLocked: false, passcodeError: null });
      persistAuthEnvelope(get());
      broadcastSync.publish({ kind: 'passcode_lock', isLocked: false });
      return true;
    },

    lockApp: () => {
      if (!get().passcodeHash) return;
      set({ isLocked: true, passcodeError: null });
      persistAuthEnvelope(get());
      broadcastSync.publish({ kind: 'passcode_lock', isLocked: true });
    },

    unlockApp: async (passcode) => {
      const expected = get().passcodeHash;
      if (!expected) {
        set({ isLocked: false, passcodeError: null });
        return true;
      }
      const candidateHash = await hashPasscode(passcode.trim());
      if (candidateHash !== expected) {
        // STRICT SECURITY INVARIANT: Never unlock or expose #app-shell on wrong passcode!
        set({
          isLocked: true,
          passcodeError: 'Incorrect passcode. Please try again.',
        });
        return false;
      }
      set({ isLocked: false, passcodeError: null });
      persistAuthEnvelope(get());
      broadcastSync.publish({ kind: 'passcode_lock', isLocked: false });
      return true;
    },
  };
});

// Listen for server-side session revocation / WS close 4001 / AuthError
getServerAdapter().onAuthInvalidated((reason) => {
  const st = useAuthStore.getState();
  if (!st.isAuthenticated && !st.activeAccountId) return;
  clearSavedActiveChatId();
  purgeAccountClientCaches(st.activeAccountId, st.accounts.length <= 1);
  onAuthClearedHook?.();
  const remaining = st.accounts.filter((a) => a.accountId !== st.activeAccountId);
  useAuthStore.setState({
    accounts: remaining,
    activeAccountId: null,
    currentUser: null,
    token: null,
    isAuthenticated: false,
    isAddingAccount: false,
    passcodeHash: remaining.length === 0 ? null : st.passcodeHash,
    isLocked: false,
    error:
      reason === 'account_deleted'
        ? '账号已注销。'
        : '登录会话已失效或被撤销，请重新登录。',
  });
  persistAuthEnvelope(useAuthStore.getState());
});

// Global Ctrl+Shift+L / Cmd+Shift+L Passcode Lock Shortcut + Multi-Tab Lock Sync
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (ev: KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'l') {
      const state = useAuthStore.getState();
      if (state.isAuthenticated && state.passcodeHash) {
        ev.preventDefault();
        state.lockApp();
      }
    }
  });
}

broadcastSync.subscribe((payload) => {
  if (payload.kind === 'passcode_lock') {
    useAuthStore.setState({ isLocked: payload.isLocked, passcodeError: null });
    return;
  }
  if (payload.kind === 'auth_switched') {
    const currentId = useAuthStore.getState().activeAccountId;
    if (payload.activeAccountId === null) {
      clearSavedActiveChatId();
      onAuthClearedHook?.();
      void getClientAdapter().disconnect().catch(() => undefined);
      useAuthStore.setState({
        accounts: loadPersistedAuth().accounts,
        activeAccountId: null,
        currentUser: null,
        token: null,
        isAuthenticated: false,
        isAddingAccount: false,
        passcodeHash: null,
        isLocked: false,
        passcodeError: null,
      });
      return;
    }
    if (payload.activeAccountId !== currentId) {
      clearSavedActiveChatId();
      onAuthClearedHook?.();
      void getClientAdapter()
        .disconnect()
        .catch(() => undefined)
        .finally(() => {
          void useAuthStore.getState().hydrateAuth();
        });
    }
  }
});
