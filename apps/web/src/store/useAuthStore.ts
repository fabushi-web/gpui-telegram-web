import { create } from 'zustand';
import {
  mapUserDtoToDomain,
  peerAvatarColorIndex,
  type AdapterMode,
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
  getMtprotoAdapter,
  getServerAdapter,
  switchClientAdapterMode,
  type MtprotoConfig,
} from '../adapters';
import { generateIdentityKeyPair, toPublishPreKeysRequest } from '../services/e2eeClient';

export const MAX_STORED_ACCOUNTS = 6;
const AUTH_STORAGE_KEY = 'gpui_tg_auth_v1';
const ACTIVE_TOKEN_MIRROR_KEY = 'gpui_tg_active_token';

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
  adapterMode: AdapterMode;
  serverUrl: string;
}

interface PersistedAuthEnvelope {
  accounts: StoredAccountSession[];
  activeAccountId: string | null;
  adapterMode: AdapterMode;
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

export interface AuthState {
  accounts: StoredAccountSession[];
  activeAccountId: string | null;
  currentUser: UserProfile | null;
  token: string | null;
  isAuthenticated: boolean;
  isAddingAccount: boolean;

  adapterMode: AdapterMode;
  serverUrl: string;
  serverHealth: ServerHealthSnapshot;
  mtprotoConfig: MtprotoConfig;

  passcodeHash: string | null;
  isLocked: boolean;
  passcodeError: string | null;

  isLoading: boolean;
  error: string | null;
  phoneCodeHash: string | null;
  pendingPhone: string | null;
  devCodeHint: string | null;
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
  setAdapterMode: (mode: AdapterMode) => Promise<void>;
  setServerUrl: (url: string) => void;
  setMtprotoConfig: (patch: Partial<MtprotoConfig>) => void;

  loginDemo: (slot?: number) => Promise<UserProfile>;
  sendPhoneCode: (phone: string) => Promise<{ phoneCodeHash: string; devCode?: string }>;
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
  simulateQrAccept: (pairId?: string) => Promise<UserProfile>;

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

  sendEmailCode: (email: string) => Promise<{ emailCodeHash: string; devCode?: string }>;
  verifyEmailCode: (params: {
    email?: string;
    code: string;
    emailCodeHash?: string;
  }) => Promise<UserProfile>;
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
  confirmAlipay: (sessionId?: string) => Promise<UserProfile>;

  registerPasskey: (label?: string) => Promise<boolean>;
  loginPasskey: (username?: string) => Promise<UserProfile>;

  switchAccount: (accountId: string) => Promise<void>;
  addAccountFlow: () => void;
  cancelAddAccountFlow: () => void;
  removeAccount: (accountId: string) => Promise<void>;
  logout: (logoutAll?: boolean) => Promise<void>;

  loadSessions: () => Promise<SessionDto[]>;
  revokeSession: (sessionId: string) => Promise<void>;
  revokeOtherSessions: () => Promise<number>;

  setPasscode: (passcode: string) => Promise<void>;
  clearPasscode: (currentPasscode?: string) => Promise<boolean>;
  lockApp: () => void;
  unlockApp: (passcode: string) => Promise<boolean>;
}

export function isDemoUiEnabled(adapterMode: AdapterMode): boolean {
  if (adapterMode === 'sandbox') return true;
  if (import.meta.env?.VITE_ENABLE_DEMO === '1') return true;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('dev') === '1' || params.get('mode') === 'sandbox') return true;
  }
  return false;
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
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function loadPersistedAuth(): PersistedAuthEnvelope {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedAuthEnvelope>;
        const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
        return {
          accounts,
          activeAccountId: parsed.activeAccountId ?? accounts[0]?.accountId ?? null,
          adapterMode: parsed.adapterMode ?? 'server',
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
    'accounts' | 'activeAccountId' | 'adapterMode' | 'serverUrl' | 'passcodeHash' | 'isLocked' | 'token'
  >,
): void {
  try {
    if (typeof localStorage !== 'undefined') {
      const env: PersistedAuthEnvelope = {
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        adapterMode: state.adapterMode,
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

function detectInitialBootOverride(): { mode?: AdapterMode; serverUrl?: string } {
  const envDefaultServer = (import.meta.env?.VITE_DEFAULT_SERVER_URL ?? '').trim().replace(/\/+$/, '');
  if (typeof window === 'undefined') {
    return envDefaultServer ? { serverUrl: envDefaultServer } : {};
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const qMode = params.get('mode');
    const qServer = params.get('server') || params.get('api');
    const validMode: AdapterMode | undefined =
      qMode === 'sandbox' || qMode === 'server' || qMode === 'mtproto' ? qMode : undefined;
    if (validMode || qServer) {
      return { mode: validMode, serverUrl: qServer?.trim().replace(/\/+$/, '') || undefined };
    }
    if (envDefaultServer && !bootAuth.serverUrl) {
      return { mode: 'server', serverUrl: envDefaultServer };
    }
    const host = window.location.hostname.toLowerCase();
    const isKnownStaticHost =
      host.endsWith('.github.io') ||
      host.endsWith('.pages.dev') ||
      host.endsWith('.netlify.app') ||
      host.endsWith('.vercel.app');
    if (isKnownStaticHost && !bootAuth.serverUrl) {
      // Production static CDN deployments connect to the real web.ombhrum.com backend instead of fake sandbox!
      return { mode: 'server', serverUrl: 'https://web.ombhrum.com' };
    }
  } catch {
    // Ignore URL parse error
  }
  return {};
}

const bootOverride = detectInitialBootOverride();
const initialServerUrl = bootOverride.serverUrl ?? bootAuth.serverUrl;
// Never restore accidental stale 'sandbox' mode in production unless explicitly requested via ?mode=sandbox
const initialAdapterMode: AdapterMode =
  bootOverride.mode ??
  (bootAuth.adapterMode === 'sandbox' && import.meta.env?.VITE_ENABLE_DEMO !== '1'
    ? 'server'
    : bootAuth.adapterMode);

if (bootOverride.mode || initialServerUrl) {
  void switchClientAdapterMode(initialAdapterMode, {
    serverUrl: initialServerUrl,
  });
}

const initialActiveAccount =
  bootAuth.accounts.find((a) => a.accountId === bootAuth.activeAccountId) ??
  bootAuth.accounts[0] ??
  null;

if (initialActiveAccount) {
  getServerAdapter().configure({
    serverUrl: bootOverride.serverUrl || initialActiveAccount.serverUrl || initialServerUrl,
    token: initialActiveAccount.token,
    accountId: initialActiveAccount.accountId,
    userId: initialActiveAccount.userId ?? initialActiveAccount.user.userId,
  });
} else {
  getServerAdapter().configure({ serverUrl: initialServerUrl });
}

let onAccountActivatedHook: ((accountId: string, user: UserProfile) => void) | null = null;

export function registerAccountActivatedHook(
  hook: ((accountId: string, user: UserProfile) => void) | null,
): void {
  onAccountActivatedHook = hook;
}

export const useAuthStore = create<AuthState>((set, get) => {
  const commitAuthSuccess = async (authRes: AuthResponse): Promise<UserProfile> => {
    const user = authResponseToUserProfile(authRes);
    const accountId = String(user.userId);
    const mode = get().adapterMode;
    const serverUrl = get().serverUrl;

    const entry: StoredAccountSession = {
      accountId,
      userId: user.userId,
      token: authRes.token,
      sessionId: authRes.session_id,
      expiresAtMs: authRes.expires_at_ms ?? Date.now() + 30 * 86_400_000,
      user,
      adapterMode: mode,
      serverUrl,
    };

    const existingOthers = get().accounts.filter((a) => a.accountId !== accountId);
    const accounts = [entry, ...existingOthers].slice(0, MAX_STORED_ACCOUNTS);

    await switchClientAdapterMode(mode, {
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

    const adapter = getClientAdapter(mode);
    await adapter.connect(authRes.token).catch(() => undefined);

    void generateIdentityKeyPair(user.userId)
      .then((identity) => adapter.publishPreKeys(toPublishPreKeysRequest(identity)))
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

    adapterMode: initialActiveAccount?.adapterMode ?? initialAdapterMode,
    serverUrl: bootOverride.serverUrl ?? initialActiveAccount?.serverUrl ?? initialServerUrl,
    serverHealth: { status: 'unknown' },
    mtprotoConfig: getMtprotoAdapter().getMtprotoConfig(),

    passcodeHash: bootAuth.passcodeHash,
    isLocked: bootAuth.isLocked,
    passcodeError: null,

    isLoading: false,
    error: null,
    phoneCodeHash: null,
    pendingPhone: null,
    devCodeHint: null,
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
      const override = detectInitialBootOverride();
      const effectiveServerUrl = override.serverUrl ?? loaded.serverUrl;
      const active =
        loaded.accounts.find((a) => a.accountId === loaded.activeAccountId) ??
        loaded.accounts[0] ??
        null;

      if (!active) {
        const resolvedMode: AdapterMode =
          override.mode ??
          (loaded.adapterMode === 'sandbox' && import.meta.env?.VITE_ENABLE_DEMO !== '1'
            ? 'server'
            : loaded.adapterMode);
        await switchClientAdapterMode(resolvedMode, { serverUrl: effectiveServerUrl });
        set({
          accounts: [],
          activeAccountId: null,
          currentUser: null,
          token: null,
          isAuthenticated: false,
          adapterMode: resolvedMode,
          serverUrl: effectiveServerUrl,
          passcodeHash: loaded.passcodeHash,
          isLocked: false,
        });
        if (resolvedMode === 'server') {
          void get().probeServerHealth(effectiveServerUrl);
        }
        return;
      }

      const activeMode = override.mode ?? active.adapterMode;
      const targetServerUrl = override.serverUrl || active.serverUrl || loaded.serverUrl;
      const adapter = await switchClientAdapterMode(activeMode, {
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
        adapterMode: activeMode,
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
        if (isAuthRejected && activeMode === 'server') {
          // Matching desktop shell.rs: clear expired/revoked session cleanly instead of showing stale cache
          const remaining = get().accounts.filter((a) => a.accountId !== active.accountId);
          set({
            accounts: remaining,
            activeAccountId: null,
            currentUser: null,
            token: null,
            isAuthenticated: false,
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

    setAdapterMode: async (mode) => {
      const state = get();
      await switchClientAdapterMode(mode, {
        serverUrl: state.serverUrl,
        token: state.token,
        accountId: state.activeAccountId ?? 'default',
        userId: state.currentUser?.userId ?? 0,
      });
      set({ adapterMode: mode, error: null });
      persistAuthEnvelope(get());
      if (state.token) {
        await getClientAdapter(mode).connect(state.token).catch(() => undefined);
      }
    },

    setServerUrl: (url) => {
      const clean = url.trim().replace(/\/+$/, '');
      getServerAdapter().configure({ serverUrl: clean });
      set({ serverUrl: clean, serverHealth: { status: 'unknown' } });
      persistAuthEnvelope(get());
    },

    setMtprotoConfig: (patch) => {
      const next = getMtprotoAdapter().setMtprotoConfig(patch);
      set({ mtprotoConfig: next });
    },

    loginDemo: async (slot = 0) => {
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter(get().adapterMode).loginDemo(slot);
        return await commitAuthSuccess(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    sendPhoneCode: async (phone) => {
      set({ isLoading: true, error: null, requires2fa: false });
      try {
        const res = await getClientAdapter(get().adapterMode).sendPhoneCode(phone);
        set({
          isLoading: false,
          pendingPhone: phone,
          phoneCodeHash: res.phone_code_hash,
          devCodeHint: res.dev_code ?? null,
        });
        return { phoneCodeHash: res.phone_code_hash, devCode: res.dev_code };
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
        const res = await getClientAdapter(get().adapterMode).verifyPhoneCode({
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
        const res = await getClientAdapter(get().adapterMode).verify2fa({
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
      const status = await getClientAdapter(get().adapterMode).get2faStatus();
      set({ twoFaStatus: status });
      return status;
    },

    set2faPassword: async (req) => {
      const status = await getClientAdapter(get().adapterMode).set2faPassword({
        current_password: req.currentPassword,
        new_password: req.newPassword,
        hint: req.hint,
        recovery_email: req.recoveryEmail,
      });
      set({ twoFaStatus: status });
      return status;
    },

    disable2faPassword: async (currentPassword) => {
      const res = await getClientAdapter(get().adapterMode).disable2faPassword(currentPassword);
      set({ twoFaStatus: { enabled: false, has_password: false } });
      return res;
    },

    startQrPairing: async (deviceName) => {
      set({ isLoading: true, error: null });
      try {
        const session = await getClientAdapter(get().adapterMode).initQrPairing(deviceName);
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
      const session = await getClientAdapter(get().adapterMode).pollQrPairing(targetId);
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

    simulateQrAccept: async (pairId) => {
      const adapter = getClientAdapter(get().adapterMode);
      const targetId = pairId ?? get().qrSession?.pair_id ?? (await get().startQrPairing()).pair_id;
      set({ isLoading: true, error: null });
      try {
        const session = await adapter.acceptQrPairing(targetId);
        set({ qrSession: session });
        if (!session.session && !(session.token && session.user)) {
          throw new Error('二维码扫码尚未获得服务器授权凭证');
        }
        const auth: AuthResponse = session.session ?? {
          user_id: session.user!.user_id,
          username: session.user!.username ?? `user${session.user!.user_id}`,
          session_id: `qr_${session.pair_id}`,
          token: session.token!,
          user: session.user,
        };
        return await commitAuthSuccess(auth);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    loginPassword: async (username, password, twoFaPassword) => {
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter(get().adapterMode).loginPassword(
          username,
          password,
          twoFaPassword,
        );
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
        const res = await getClientAdapter(get().adapterMode).registerPassword({
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

    sendEmailCode: async (email) => {
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter(get().adapterMode).sendEmailCode(email);
        set({
          isLoading: false,
          pendingEmail: email,
          emailCodeHash: res.email_code_hash,
          devCodeHint: res.dev_code ?? null,
        });
        return { emailCodeHash: res.email_code_hash, devCode: res.dev_code };
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
        const res = await getClientAdapter(get().adapterMode).verifyEmailCode({
          email,
          code: params.code,
          email_code_hash,
        });
        return await commitAuthSuccess(res);
      } catch (err) {
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
        const adapter = getClientAdapter(get().adapterMode);
        const res = adapter.emailRegister
          ? await adapter.emailRegister({
              email,
              code: params.code,
              username: params.username,
              password: params.password,
              first_name: params.firstName,
              last_name: params.lastName,
              email_code_hash,
            })
          : await adapter.verifyEmailCode({ email, code: params.code, email_code_hash });
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
        const session = await getClientAdapter(get().adapterMode).startAlipayAuth();
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
      const polled = await getClientAdapter(get().adapterMode).pollAlipayAuth(targetId);
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

    confirmAlipay: async (sessionId) => {
      let targetId = sessionId ?? get().alipaySession?.session_id;
      if (!targetId) {
        const created = await get().startAlipay();
        targetId = created.session_id;
      }
      set({ isLoading: true, error: null });
      try {
        const res = await getClientAdapter(get().adapterMode).confirmAlipayAuth(targetId);
        return await commitAuthSuccess(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    registerPasskey: async (label = 'GPUI Web Passkey') => {
      const adapter = getClientAdapter(get().adapterMode);
      const user = get().currentUser;
      if (!user) {
        throw new Error('请先登录后再绑定通行密钥 (Passkey)');
      }
      const challenge = await adapter.getPasskeyChallenge(user.username);

      let credId: string | undefined;
      let publicKeyB64 = '';

      if (
        typeof window !== 'undefined' &&
        typeof window.PublicKeyCredential !== 'undefined' &&
        navigator.credentials &&
        typeof navigator.credentials.create === 'function'
      ) {
        const userIdBytes = new TextEncoder().encode(String(user.userId));
        const created = (await navigator.credentials.create({
          publicKey: {
            challenge: base64ToUint8Array(challenge.challenge) as BufferSource,
            rp: {
              name: 'GPUI Telegram Web',
              id: challenge.rp_id || window.location.hostname || 'localhost',
            },
            user: {
              id: userIdBytes as BufferSource,
              name: user.username || `user_${user.userId}`,
              displayName:
                `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
                user.username ||
                `User ${user.userId}`,
            },
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            authenticatorSelection: {
              userVerification: 'preferred',
              residentKey: 'preferred',
            },
            timeout: 60_000,
          },
        })) as PublicKeyCredential | null;

        if (created) {
          credId = created.id || arrayBufferToBase64Url(created.rawId);
          const resp = created.response as AuthenticatorAttestationResponse;
          if (typeof resp.getPublicKey === 'function') {
            const pk = resp.getPublicKey();
            if (pk) publicKeyB64 = arrayBufferToBase64Url(pk);
          }
        }
      } else if (get().adapterMode === 'sandbox') {
        credId = `pk_cred_${Date.now()}`;
      } else {
        throw new Error('当前浏览器或环境不支持 WebAuthn Passkey（需要 HTTPS 安全上下文）');
      }

      if (!credId) {
        throw new Error('已取消创建通行密钥');
      }

      const res = await adapter.registerPasskey({
        cred_id: credId,
        label,
        public_key_b64: publicKeyB64 || undefined,
      });
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('gpui_tg_last_passkey_id', res.cred_id || credId);
        }
      } catch {
        // Ignore
      }
      return Boolean(res.cred_id);
    },

    loginPasskey: async (username) => {
      set({ isLoading: true, error: null });
      try {
        const adapter = getClientAdapter(get().adapterMode);
        const challenge = await adapter.getPasskeyChallenge(username);
        let credentialId: string | undefined;

        if (
          typeof window !== 'undefined' &&
          typeof window.PublicKeyCredential !== 'undefined' &&
          navigator.credentials &&
          typeof navigator.credentials.get === 'function'
        ) {
          const assertion = (await navigator.credentials.get({
            publicKey: {
              challenge: base64ToUint8Array(challenge.challenge) as BufferSource,
              rpId: challenge.rp_id || window.location.hostname || 'localhost',
              userVerification: 'preferred',
              timeout: 60_000,
            },
          })) as PublicKeyCredential | null;
          if (assertion) {
            credentialId = assertion.id || arrayBufferToBase64Url(assertion.rawId);
          }
        } else if (get().adapterMode === 'sandbox') {
          credentialId =
            (typeof localStorage !== 'undefined'
              ? localStorage.getItem('gpui_tg_last_passkey_id')
              : null) ?? `pk_sandbox_${Date.now()}`;
        } else {
          throw new Error('当前浏览器不支持 WebAuthn 通行密钥，请使用 HTTPS 或切换其他登录方式');
        }

        if (!credentialId) {
          throw new Error('未获取到通行密钥凭证');
        }

        const auth = await adapter.verifyPasskey({
          challenge_id: challenge.challenge_id,
          credential_id: credentialId,
        });
        return await commitAuthSuccess(auth);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ isLoading: false, error: msg });
        throw err;
      }
    },

    switchAccount: async (accountId) => {
      const target = get().accounts.find((a) => a.accountId === accountId);
      if (!target) return;

      await getClientAdapter(get().adapterMode).disconnect().catch(() => undefined);

      const adapter = await switchClientAdapterMode(target.adapterMode, {
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
        adapterMode: target.adapterMode,
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
          await get().switchAccount(remaining[0].accountId);
          return;
        }
        await get().logout(true);
        return;
      }
      set({ accounts: remaining });
      persistAuthEnvelope(get());
    },

    logout: async (logoutAll = false) => {
      const currentId = get().activeAccountId;
      await getClientAdapter(get().adapterMode).logout().catch(() => undefined);

      const remaining = logoutAll
        ? []
        : get().accounts.filter((a) => a.accountId !== currentId);

      if (remaining.length > 0 && !logoutAll) {
        set({ accounts: remaining });
        await get().switchAccount(remaining[0].accountId);
        return;
      }

      set({
        accounts: [],
        activeAccountId: null,
        currentUser: null,
        token: null,
        isAuthenticated: false,
        isAddingAccount: false,
        isLocked: false,
        requires2fa: false,
        twoFaChallengeToken: null,
        qrSession: null,
        alipaySession: null,
      });
      persistAuthEnvelope(get());
      broadcastSync.publish({ kind: 'auth_switched', activeAccountId: null });
    },

    loadSessions: async () => {
      const sessions = await getClientAdapter(get().adapterMode).listSessions();
      set({ activeSessions: sessions });
      return sessions;
    },

    revokeSession: async (sessionId) => {
      await getClientAdapter(get().adapterMode).revokeSession(sessionId);
      await get().loadSessions();
    },

    revokeOtherSessions: async () => {
      const count = await getClientAdapter(get().adapterMode).revokeOtherSessions();
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
  }
});
