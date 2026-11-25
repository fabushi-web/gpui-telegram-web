import React, { useEffect, useRef, useState } from 'react';
import '../../styles/ai-miniapps.css';
import {
  DEFAULT_ARGON2_KDF_PARAMS,
  DOM_IDS,
  USER_VAULT_KDF_ALG_SPLIT_KEY_V2,
  peerAvatarColorIndex,
  type PendingDeviceSyncItem,
} from '@gpui-telegram/protocol';
import { indexedDbCache } from '../../adapters';
import { type LocaleCode } from '../../i18n';
import {
  bytesToBase64,
  deriveSplitKeyV2,
  generateDeviceSyncKeyPair,
  generateRandomSaltB64,
  generateVaultRootKey,
  sealRootKeyForDevice,
  wrapVaultRootKey,
} from '../../services/splitKeyCrypto';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import {
  NON_PURPLE_ACCENT_SWATCHES,
  useSettingsStore,
  type ThemeName,
} from '../../store/useSettingsStore';
import { useUiStore, type ModalId, type SettingsSectionId } from '../../store/useUiStore';
import { MagpieGatewayPanel } from '../ai/MagpieGatewayPanel';

export interface SettingsPanelProps {
  className?: string;
}

type ExtendedSettingsSectionId = SettingsSectionId | 'vault';

interface SectionDescriptor {
  id: Exclude<ExtendedSettingsSectionId, 'root'>;
  icon: string;
  titleEn: string;
  titleZh: string;
}

const SETTINGS_SECTIONS: readonly SectionDescriptor[] = [
  { id: 'edit_profile', icon: '👤', titleEn: 'Edit Profile', titleZh: '编辑个人资料' },
  { id: 'appearance', icon: '🎨', titleEn: 'Appearance & Themes', titleZh: '外观与主题' },
  { id: 'general', icon: '⚙️', titleEn: 'General Settings', titleZh: '通用设置' },
  { id: 'wallpaper', icon: '🖼️', titleEn: 'Chat Wallpaper', titleZh: '聊天壁纸' },
  { id: 'notifications', icon: '🔔', titleEn: 'Notifications & Sounds', titleZh: '通知与声音' },
  { id: 'privacy', icon: '🛡️', titleEn: 'Privacy & Security', titleZh: '隐私与安全' },
  { id: 'vault', icon: '🔐', titleEn: 'E2EE Vault & Device Sync', titleZh: '端到端保险库与设备同步' },
  { id: 'passcode', icon: '🔒', titleEn: 'Local Passcode Lock', titleZh: '本地密码锁' },
  { id: 'two_fa', icon: '🔑', titleEn: 'Two-Step Verification (2FA)', titleZh: '两步验证云密码' },
  { id: 'passkeys', icon: '🪪', titleEn: 'Passkeys (WebAuthn)', titleZh: '通行密钥 (Passkeys)' },
  { id: 'blocked_users', icon: '🚫', titleEn: 'Blocked Users', titleZh: '黑名单管理' },
  { id: 'auto_delete', icon: '⏱️', titleEn: 'Auto-Delete Messages', titleZh: '全局自动删除' },
  { id: 'folders', icon: '📁', titleEn: 'Chat Folders', titleZh: '会话分组文件夹' },
  { id: 'devices', icon: '💻', titleEn: 'Devices & Sessions', titleZh: '登录设备与会话' },
  { id: 'data_storage', icon: '💾', titleEn: 'Data & Storage', titleZh: '数据与存储' },
  { id: 'language', icon: '🌐', titleEn: 'Language', titleZh: '语言设置' },
  { id: 'stickers', icon: '😊', titleEn: 'Stickers & Emoji', titleZh: '贴纸与表情' },
  { id: 'power_saving', icon: '🔋', titleEn: 'Power Saving', titleZh: '省电模式' },
  { id: 'chat_export', icon: '📦', titleEn: 'Export Chat History', titleZh: '导出聊天记录' },
  { id: 'connection_mode', icon: '🔌', titleEn: 'Server Connection', titleZh: '服务器连接' },
  { id: 'magpie_gateway', icon: '🧭', titleEn: 'Magpie LLM Gateway', titleZh: '喜鹊模型网关' },
  { id: 'hermes_studio', icon: '⚡', titleEn: 'Fabushi / Hermes Studio', titleZh: '法布施智能工作台' },
  { id: 'browser_control', icon: '🌐', titleEn: 'Built-in Browser Bridge', titleZh: '内置浏览器桥接' },
  { id: 'wallet', icon: '⭐', titleEn: 'Stars & TON Wallet', titleZh: '星币与钱包' },
  { id: 'about', icon: 'ℹ️', titleEn: 'About & Shortcuts', titleZh: '关于与快捷键' },
] as const;

const THEME_OPTIONS: ReadonlyArray<{
  id: ThemeName;
  labelEn: string;
  labelZh: string;
  swatch: string;
}> = [
  { id: 'night', labelEn: 'Night (Apple Dark)', labelZh: '夜间深色 (Night)', swatch: '#0E0E0E' },
  { id: 'tinted', labelEn: 'Tinted (Graphite)', labelZh: '冷色石墨 (Tinted)', swatch: '#15191E' },
  { id: 'day', labelEn: 'Day (Clean Light)', labelZh: '日间浅色 (Day)', swatch: '#FFFFFF' },
  { id: 'classic', labelEn: 'Classic', labelZh: '经典 (Classic)', swatch: '#E8F0E4' },
];

const WALLPAPER_PRESETS: ReadonlyArray<{
  id: string;
  labelEn: string;
  labelZh: string;
  previewCss: string;
}> = [
  { id: 'default', labelEn: 'Apple Obsidian', labelZh: '苹果曜黑', previewCss: '#161616' },
  {
    id: 'ocean',
    labelEn: 'Ocean Horizon',
    labelZh: '远洋蓝光',
    previewCss: 'linear-gradient(135deg, #0E0E0E 0%, #0A84FF 100%)',
  },
  {
    id: 'emerald',
    labelEn: 'Emerald Pine',
    labelZh: '翡翠松林',
    previewCss: 'linear-gradient(135deg, #0E0E0E 0%, #00BA69 100%)',
  },
  {
    id: 'amber',
    labelEn: 'Amber Dusk',
    labelZh: '琥珀暖光',
    previewCss: 'linear-gradient(135deg, #141414 0%, #E5A030 100%)',
  },
  {
    id: 'graphite',
    labelEn: 'Graphite Sky',
    labelZh: '石墨微光',
    previewCss: 'radial-gradient(circle at 50% 35%, #29B6F6 0%, #0E0E0E 85%)',
  },
  { id: 'solid', labelEn: 'Pure Matte', labelZh: '纯净哑光', previewCss: '#0E0E0E' },
];

const PRIVACY_LEVELS = [
  { value: 'everybody', labelEn: 'Everybody', labelZh: '所有人' },
  { value: 'contacts', labelEn: 'My Contacts', labelZh: '仅联系人' },
  { value: 'nobody', labelEn: 'Nobody', labelZh: '没有人' },
] as const;

const GLOBAL_TTL_OPTIONS = [
  { seconds: 0, labelEn: 'Off', labelZh: '关闭' },
  { seconds: 86_400, labelEn: '1 Day', labelZh: '1 天' },
  { seconds: 604_800, labelEn: '1 Week', labelZh: '1 周' },
  { seconds: 2_592_000, labelEn: '1 Month', labelZh: '1 个月' },
] as const;

const SETTINGS_EXTRAS_KEY = 'fabushi_settings_extras_v1';

interface SettingsExtras {
  timeFormat24h: boolean;
  notifSound: boolean;
  notifPreview: boolean;
  notifReactions: boolean;
  autoplayGifs: boolean;
  autoplayVideos: boolean;
}

const DEFAULT_EXTRAS: SettingsExtras = {
  timeFormat24h: true,
  notifSound: true,
  notifPreview: true,
  notifReactions: true,
  autoplayGifs: true,
  autoplayVideos: false,
};

function loadSettingsExtras(): SettingsExtras {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SETTINGS_EXTRAS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SettingsExtras>;
        return { ...DEFAULT_EXTRAS, ...parsed };
      }
    }
  } catch {
    // Ignore storage error
  }
  return { ...DEFAULT_EXTRAS };
}

function saveSettingsExtras(next: SettingsExtras): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SETTINGS_EXTRAS_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignore storage error
  }
}

export function openShortcutsModalImperatively(): void {
  useUiStore.setState({
    activeModal: 'shortcuts' as ModalId,
    modalPayload: { source: 'settings' },
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('gpui:open-shortcuts'));
  }
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ className }) => {
  const settingsStack = useUiStore((s) => s.settingsStack);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const setActiveNavDest = useUiStore((s) => s.setActiveNavDest);
  const openModal = useUiStore((s) => s.openModal);
  const pushToast = useUiStore((s) => s.pushToast);

  // Settings store
  const theme = useSettingsStore((s) => s.theme);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const wallpaper = useSettingsStore((s) => s.wallpaper);
  const wallpaperBlur = useSettingsStore((s) => s.wallpaperBlur);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const bubbleRadius = useSettingsStore((s) => s.bubbleRadius);
  const uiScale = useSettingsStore((s) => s.uiScale);
  const language = useSettingsStore((s) => s.language);
  const sendByEnter = useSettingsStore((s) => s.sendByEnter);
  const autoTranslate = useSettingsStore((s) => s.autoTranslate);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const powerSaving = useSettingsStore((s) => s.powerSaving);
  const globalTtl = useSettingsStore((s) => s.globalTtl);

  const setTheme = useSettingsStore((s) => s.setTheme);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const setWallpaper = useSettingsStore((s) => s.setWallpaper);
  const setWallpaperBlur = useSettingsStore((s) => s.setWallpaperBlur);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setBubbleRadius = useSettingsStore((s) => s.setBubbleRadius);
  const setUiScale = useSettingsStore((s) => s.setUiScale);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setSendByEnter = useSettingsStore((s) => s.setSendByEnter);
  const setAutoTranslate = useSettingsStore((s) => s.setAutoTranslate);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const setPowerSaving = useSettingsStore((s) => s.setPowerSaving);
  const setGlobalTtl = useSettingsStore((s) => s.setGlobalTtl);
  const resetAppearance = useSettingsStore((s) => s.resetAppearance);

  // Auth store (strictly real server auth, zero sandbox/mtproto/demo shims)
  const currentUser = useAuthStore((s) => s.currentUser);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const serverHealth = useAuthStore((s) => s.serverHealth);
  const passcodeHash = useAuthStore((s) => s.passcodeHash);
  const twoFaStatus = useAuthStore((s) => s.twoFaStatus);
  const activeSessions = useAuthStore((s) => s.activeSessions);

  const setServerUrl = useAuthStore((s) => s.setServerUrl);
  const probeServerHealth = useAuthStore((s) => s.probeServerHealth);
  const setPasscode = useAuthStore((s) => s.setPasscode);
  const clearPasscode = useAuthStore((s) => s.clearPasscode);
  const lockApp = useAuthStore((s) => s.lockApp);
  const refresh2faStatus = useAuthStore((s) => s.refresh2faStatus);
  const set2faPassword = useAuthStore((s) => s.set2faPassword);
  const disable2faPassword = useAuthStore((s) => s.disable2faPassword);
  const registerPasskey = useAuthStore((s) => s.registerPasskey);
  const loadSessions = useAuthStore((s) => s.loadSessions);
  const revokeSession = useAuthStore((s) => s.revokeSession);
  const revokeOtherSessions = useAuthStore((s) => s.revokeOtherSessions);
  const upgradeSplitKey = useAuthStore((s) => s.upgradeSplitKey);
  const changePassword = useAuthStore((s) => s.changePassword);
  const deleteAccount = useAuthStore((s) => s.deleteAccount);

  // Chat store
  const activeChatId = useChatStore((s) => s.activeChatId);
  const orderedChatIds = useChatStore((s) => s.orderedChatIds);
  const chatsById = useChatStore((s) => s.chatsById);
  const folders = useChatStore((s) => s.folders);
  const blockedUsers = useChatStore((s) => s.blockedUsers);
  const privacySettings = useChatStore((s) => s.privacySettings);
  const stickerSets = useChatStore((s) => s.stickerSets);

  const updateMyProfile = useChatStore((s) => s.updateMyProfile);
  const loadPrivacyAndBlocked = useChatStore((s) => s.loadPrivacyAndBlocked);
  const updatePrivacy = useChatStore((s) => s.updatePrivacy);
  const toggleBlockUser = useChatStore((s) => s.toggleBlockUser);
  const upsertFolder = useChatStore((s) => s.upsertFolder);
  const deleteFolder = useChatStore((s) => s.deleteFolder);
  const loadStickersAndGifs = useChatStore((s) => s.loadStickersAndGifs);
  const installStickerSet = useChatStore((s) => s.installStickerSet);
  const exportChatHistory = useChatStore((s) => s.exportChatHistory);

  // AI, Vault & Passkeys store
  const wallet = useAiWorkspaceStore((s) => s.wallet);
  const pairingTicket = useAiWorkspaceStore((s) => s.pairingTicket);
  const localBridgeState = useAiWorkspaceStore((s) => s.localBridgeState);
  const vaultEnvelope = useAiWorkspaceStore((s) => s.vaultEnvelope);
  const vaultItems = useAiWorkspaceStore((s) => s.vaultItems);
  const vaultLatestRevision = useAiWorkspaceStore((s) => s.vaultLatestRevision);
  const pendingDeviceSyncs = useAiWorkspaceStore((s) => s.pendingDeviceSyncs);
  const activeDeviceSyncRequest = useAiWorkspaceStore((s) => s.activeDeviceSyncRequest);
  const accountPasskeys = useAiWorkspaceStore((s) => s.accountPasskeys);

  const loadWallet = useAiWorkspaceStore((s) => s.loadWallet);
  const loadVaultState = useAiWorkspaceStore((s) => s.loadVaultState);
  const saveVaultEnvelope = useAiWorkspaceStore((s) => s.saveVaultEnvelope);
  const requestDeviceSync = useAiWorkspaceStore((s) => s.requestDeviceSync);
  const approveDeviceSync = useAiWorkspaceStore((s) => s.approveDeviceSync);
  const denyDeviceSync = useAiWorkspaceStore((s) => s.denyDeviceSync);
  const loadAccountPasskeys = useAiWorkspaceStore((s) => s.loadAccountPasskeys);
  const deleteAccountPasskey = useAiWorkspaceStore((s) => s.deleteAccountPasskey);

  const isZh = language === 'zh-CN';
  const isOpen = settingsStack.length > 0;
  const currentSection: ExtendedSettingsSectionId =
    settingsStack[settingsStack.length - 1] ?? 'root';

  // Persisted extra switches
  const [extras, setExtras] = useState<SettingsExtras>(() => loadSettingsExtras());
  const updateExtra = <K extends keyof SettingsExtras>(key: K, val: SettingsExtras[K]) => {
    setExtras((prev) => {
      const next = { ...prev, [key]: val };
      saveSettingsExtras(next);
      return next;
    });
  };

  // Profile form
  const [profileFirstName, setProfileFirstName] = useState('');
  const [profileLastName, setProfileLastName] = useState('');
  const [profileUsername, setProfileUsername] = useState('');
  const [profileBio, setProfileBio] = useState('');

  // Passcode & 2FA forms
  const [passcodeInput, setPasscodeInput] = useState('');
  const [twoFaCurrentPwd, setTwoFaCurrentPwd] = useState('');
  const [twoFaNewPwd, setTwoFaNewPwd] = useState('');
  const [twoFaHintInput, setTwoFaHintInput] = useState('');
  const [twoFaEmailInput, setTwoFaEmailInput] = useState('');

  // Server Passkeys
  const [passkeyLabel, setPasskeyLabel] = useState('Fabushi Web Passkey');
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  // Split-Key V2 Vault & X25519 Device Sync forms
  const [vaultInitPassword, setVaultInitPassword] = useState('');
  const [upgradeOldPwd, setUpgradeOldPwd] = useState('');
  const [rotateOldSecret, setRotateOldSecret] = useState('');
  const [rotateNewPwd, setRotateNewPwd] = useState('');
  const [syncDeviceName, setSyncDeviceName] = useState('Fabushi Web Browser');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultNotice, setVaultNotice] = useState<string | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);

  // Folders
  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [newFolderEmoji, setNewFolderEmoji] = useState('📁');

  // Export & Connection
  const [exportChatId, setExportChatId] = useState<number | null>(null);
  const [serverUrlDraft, setServerUrlDraft] = useState(serverUrl);
  const [cacheClearedAt, setCacheClearedAt] = useState<string | null>(null);
  const wpFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!currentUser) return;
    setProfileFirstName(currentUser.firstName ?? '');
    setProfileLastName(currentUser.lastName ?? '');
    setProfileUsername(currentUser.username ?? '');
    setProfileBio(currentUser.bio ?? '');
  }, [
    currentUser?.userId,
    currentUser?.firstName,
    currentUser?.lastName,
    currentUser?.username,
    currentUser?.bio,
  ]);

  useEffect(() => {
    setExportChatId(activeChatId ?? orderedChatIds[0] ?? null);
  }, [activeChatId, orderedChatIds]);

  useEffect(() => {
    setServerUrlDraft(serverUrl);
  }, [serverUrl]);

  // Lazy-load section-specific live server data
  useEffect(() => {
    if (!isOpen) return;
    if (currentSection === 'privacy' || currentSection === 'blocked_users') {
      void loadPrivacyAndBlocked().catch(() => undefined);
    } else if (currentSection === 'two_fa') {
      void refresh2faStatus().catch(() => undefined);
    } else if (currentSection === 'passkeys') {
      void loadAccountPasskeys().catch(() => undefined);
    } else if (currentSection === 'devices') {
      void loadSessions().catch(() => undefined);
    } else if (currentSection === 'stickers') {
      void loadStickersAndGifs().catch(() => undefined);
    } else if (currentSection === 'wallet') {
      void loadWallet().catch(() => undefined);
    } else if (currentSection === 'vault') {
      void loadVaultState().catch(() => undefined);
    }
  }, [
    isOpen,
    currentSection,
    loadPrivacyAndBlocked,
    refresh2faStatus,
    loadAccountPasskeys,
    loadSessions,
    loadStickersAndGifs,
    loadWallet,
    loadVaultState,
  ]);

  if (!isOpen) return null;

  const selectSection = (section: Exclude<ExtendedSettingsSectionId, 'root'>) => {
    // Keep stack clean: ['root', section] so switching sections is always 1-click & Escape cleanly pops
    useUiStore.setState({ settingsStack: ['root', section as SettingsSectionId] });
  };

  const handleInitVaultEnvelope = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setVaultError(null);
    setVaultNotice(null);
    if (!vaultInitPassword.trim()) {
      setVaultError('Enter your vault passphrase to wrap the root key locally');
      return;
    }
    setVaultBusy(true);
    try {
      const saltB64 = generateRandomSaltB64(16);
      const derived = await deriveSplitKeyV2(
        vaultInitPassword,
        saltB64,
        DEFAULT_ARGON2_KDF_PARAMS,
      );
      const rootKey = generateVaultRootKey();
      const wrappedRoot = await wrapVaultRootKey(rootKey, derived.vaultWrapKeyBytes);
      const recoveryKey = generateVaultRootKey();
      const recoveryWrapped = await wrapVaultRootKey(rootKey, recoveryKey);
      await saveVaultEnvelope({
        key_version: (vaultEnvelope?.key_version ?? 0) + 1,
        kdf_alg: USER_VAULT_KDF_ALG_SPLIT_KEY_V2,
        kdf_salt_b64: saltB64,
        kdf_m_cost_kib: DEFAULT_ARGON2_KDF_PARAMS.m_cost_kib,
        kdf_t_cost: DEFAULT_ARGON2_KDF_PARAMS.t_cost,
        kdf_p_cost: DEFAULT_ARGON2_KDF_PARAMS.p_cost,
        wrapped_root_key_b64: wrappedRoot,
        recovery_wrapped_root_key_b64: recoveryWrapped,
      });
      setVaultInitPassword('');
      setVaultNotice('Saved Split-Key V2 E2EE Vault key envelope to server');
      pushToast('E2EE Vault key envelope updated', 'success');
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setVaultBusy(false);
    }
  };

  const handleRequestDeviceSync = async () => {
    setVaultError(null);
    setVaultNotice(null);
    setVaultBusy(true);
    try {
      let pubKeyB64: string;
      try {
        const pair = await generateDeviceSyncKeyPair();
        pubKeyB64 = pair.publicKeyB64;
      } catch {
        // Fallback for older browser engines without WebCrypto X25519
        const raw = new Uint8Array(32);
        crypto.getRandomValues(raw);
        raw[0] |= 1;
        pubKeyB64 = bytesToBase64(raw);
      }
      const res = await requestDeviceSync({
        device_name: syncDeviceName.trim() || 'Fabushi Web Browser',
        device_public_key_b64: pubKeyB64,
      });
      setVaultNotice(
        `Device sync request ${res.request_id} created — Verification Code: ${res.verification_code}`,
      );
      pushToast(`Device Sync Code: ${res.verification_code}`, 'success');
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setVaultBusy(false);
    }
  };

  const handleApproveDeviceSync = async (item: PendingDeviceSyncItem) => {
    setVaultError(null);
    setVaultBusy(true);
    try {
      const rootKey = generateVaultRootKey();
      const sealed = await sealRootKeyForDevice(rootKey, item.device_public_key_b64);
      await approveDeviceSync(item.request_id, sealed);
      pushToast(`Approved device sync for ${item.device_name}`, 'success');
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setVaultBusy(false);
    }
  };

  const handleExport = async (format: 'json' | 'html') => {
    if (!exportChatId) {
      pushToast(isZh ? '请先选择要导出的会话' : 'Select a chat to export first', 'warning');
      return;
    }
    try {
      await exportChatHistory(exportChatId, format);
      pushToast(`Exported chat #${exportChatId} (${format.toUpperCase()})`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const displayName =
    [currentUser?.firstName, currentUser?.lastName].filter(Boolean).join(' ') ||
    currentUser?.username ||
    'Fabushi User';
  const avatarIdx = peerAvatarColorIndex(currentUser?.userId ?? 1);

  const vaultPasswordCount = vaultItems.filter((i) => !i.deleted && i.category === 'password').length;
  const vaultCookieCount = vaultItems.filter(
    (i) => !i.deleted && i.category === 'browser_cookie',
  ).length;
  const vaultOAuthCount = vaultItems.filter((i) => !i.deleted && i.category === 'ai_oauth').length;

  return (
    <div
      className="tg-settings-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettings();
      }}
    >
      <aside
        id={DOM_IDS.SETTINGS_PANEL}
        className={`tg-settings-panel ${className ?? ''}`.trim()}
        aria-label="Fabushi Web Settings"
      >
        {/* Top Bar */}
        <header className="tg-settings-topbar">
          <div className="tg-ai-row">
            <strong>⚙️ {isZh ? '系统设置' : 'Settings'}</strong>
            <span className="tg-ai-badge tg-ai-badge--accent">Fabushi Web v1.6.11</span>
          </div>
          <div className="tg-ai-row">
            <button
              type="button"
              className="tg-btn tg-btn--ghost"
              onClick={openShortcutsModalImperatively}
            >
              ⌨️ ?
            </button>
            <button type="button" className="tg-btn tg-btn--ghost" onClick={closeSettings}>
              ✕ {isZh ? '关闭' : 'Close'}
            </button>
          </div>
        </header>

        {/* Persistent 2-Pane Apple System Settings Layout */}
        <div className="tg-settings-layout">
          {/* Left Navigation Rail — ALL 25 [data-settings-section] buttons stay visible */}
          <nav className="tg-settings-nav" aria-label="Settings Categories">
            <div className="tg-settings-nav-profile">
              <div
                className={`tg-avatar tg-avatar--c${avatarIdx}`}
                style={{ width: 38, height: 38, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, flexShrink: 0 }}
              >
                {displayName.slice(0, 1).toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName}
                </div>
                <div className="tg-ai-workspace__subtitle">
                  {currentUser?.username ? `@${currentUser.username}` : 'Fabushi v1.6.11'}
                </div>
              </div>
            </div>

            {SETTINGS_SECTIONS.map((sec) => {
              const active = currentSection === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  data-settings-section={sec.id}
                  aria-current={active ? 'page' : undefined}
                  className={`tg-settings-nav-item ${
                    active ? 'tg-settings-nav-item--active' : ''
                  }`}
                  onClick={() => selectSection(sec.id)}
                >
                  <span>{sec.icon}</span>
                  <span>{isZh ? sec.titleZh : sec.titleEn}</span>
                </button>
              );
            })}
          </nav>

          {/* Right Detail Pane */}
          <div className="tg-settings-detail">
            {/* ROOT OVERVIEW */}
            {currentSection === 'root' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  ✨ {isZh ? '法布施 Web · v1.6.11 概览' : 'Fabushi Web · v1.6.11 Overview'}
                </h3>
                <p className="tg-ai-workspace__subtitle" style={{ margin: 0, lineHeight: 1.6 }}>
                  {isZh
                    ? '从左侧栏选择任意设置分类：支持 Apple Messages 与 Muse 主题、Split-Key V2 零知识保险库、X25519 设备信任环、独立隔离的 Magpie v1.6 模型网关及真实 WebAuthn 通行密钥。'
                    : 'Choose any settings category on the left: Apple Messages & Muse themes, Split-Key V2 E2EE User Vault, X25519 Device Trust Ring, user-scoped Magpie v1.6 LLM Gateway, and server-verified WebAuthn Passkeys.'}
                </p>
                <div className="tg-ai-row">
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={() => selectSection('vault')}
                  >
                    🔐 {isZh ? '打开 E2EE 保险库' : 'Open E2EE Vault'}
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => selectSection('magpie_gateway')}
                  >
                    🧭 {isZh ? '配置 Magpie 模型网关' : 'Configure Magpie Gateway'}
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--ghost"
                    onClick={openShortcutsModalImperatively}
                  >
                    ⌨️ {isZh ? '快捷键 (?)' : 'Keyboard Shortcuts (?)'}
                  </button>
                </div>
              </div>
            )}

            {/* EDIT PROFILE */}
            {currentSection === 'edit_profile' && (
              <form
                className="tg-ai-card"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await updateMyProfile({
                      firstName: profileFirstName.trim(),
                      lastName: profileLastName.trim(),
                      username: profileUsername.trim() || undefined,
                      bio: profileBio.trim(),
                    });
                    pushToast(isZh ? '个人资料已保存' : 'Profile saved', 'success');
                  } catch (err) {
                    pushToast(err instanceof Error ? err.message : String(err), 'error');
                  }
                }}
              >
                <h3 className="tg-ai-card__title">👤 {isZh ? '编辑个人资料' : 'Edit Profile'}</h3>
                <div className="tg-ai-field-grid">
                  <label className="tg-ai-field">
                    <span>{isZh ? '名 (First Name)' : 'First Name'}</span>
                    <input
                      type="text"
                      value={profileFirstName}
                      onChange={(e) => setProfileFirstName(e.target.value)}
                      required
                    />
                  </label>
                  <label className="tg-ai-field">
                    <span>{isZh ? '姓 (Last Name)' : 'Last Name'}</span>
                    <input
                      type="text"
                      value={profileLastName}
                      onChange={(e) => setProfileLastName(e.target.value)}
                    />
                  </label>
                  <label className="tg-ai-field">
                    <span>@username</span>
                    <input
                      type="text"
                      value={profileUsername}
                      onChange={(e) => setProfileUsername(e.target.value)}
                    />
                  </label>
                </div>
                <label className="tg-ai-field">
                  <span>{isZh ? '个人简介 (Bio)' : 'Bio'}</span>
                  <textarea
                    rows={3}
                    value={profileBio}
                    onChange={(e) => setProfileBio(e.target.value)}
                  />
                </label>
                <button type="submit" className="tg-btn tg-btn--primary">
                  {isZh ? '保存资料' : 'Save Profile'}
                </button>
              </form>
            )}

            {/* APPEARANCE & THEMES */}
            {currentSection === 'appearance' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  🎨 {isZh ? '外观与主题 (Apple Messages & Muse)' : 'Appearance & Themes'}
                </h3>
                <div className="tg-ai-grid">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      data-theme-option={opt.id}
                      data-testid={`theme-${opt.id}`}
                      className={`tg-btn ${theme === opt.id ? 'tg-btn--primary' : 'tg-btn--secondary'}`}
                      onClick={() => setTheme(opt.id)}
                    >
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: opt.swatch,
                          border: '1px solid var(--tg-border-strong)',
                          display: 'inline-block',
                          marginRight: 6,
                        }}
                      />
                      {isZh ? opt.labelZh : opt.labelEn}
                    </button>
                  ))}
                </div>

                <div>
                  <div className="tg-ai-workspace__subtitle" style={{ marginBottom: 6 }}>
                    {isZh ? '强调色 (零紫色色板)' : 'Accent Color (Zero-Purple Swatches)'}
                  </div>
                  <div className="tg-ai-row">
                    {NON_PURPLE_ACCENT_SWATCHES.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        aria-label={`Accent ${hex}`}
                        onClick={() => setAccentColor(hex)}
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: '50%',
                          background: hex,
                          border:
                            accentColor.toUpperCase() === hex.toUpperCase()
                              ? '2px solid #FFFFFF'
                              : '1px solid var(--tg-border)',
                          cursor: 'pointer',
                        }}
                      />
                    ))}
                  </div>
                </div>

                <label className="tg-ai-field">
                  <span>
                    {isZh ? '消息字号' : 'Font Size'}: {fontSize}px
                  </span>
                  <input
                    type="range"
                    min={12}
                    max={20}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                </label>

                <label className="tg-ai-field">
                  <span>
                    {isZh ? '气泡圆角' : 'Bubble Radius'}: {bubbleRadius}px
                  </span>
                  <input
                    type="range"
                    min={6}
                    max={22}
                    value={bubbleRadius}
                    onChange={(e) => setBubbleRadius(Number(e.target.value))}
                  />
                </label>

                <label className="tg-ai-field">
                  <span>
                    {isZh ? '界面缩放' : 'UI Scale'}: {uiScale}%
                  </span>
                  <input
                    type="range"
                    min={80}
                    max={140}
                    step={5}
                    value={uiScale}
                    onChange={(e) => setUiScale(Number(e.target.value))}
                  />
                </label>

                <button type="button" className="tg-btn tg-btn--ghost" onClick={resetAppearance}>
                  {isZh ? '恢复默认外观' : 'Reset Appearance'}
                </button>
              </div>
            )}

            {/* GENERAL SETTINGS (Persisted Switches!) */}
            {currentSection === 'general' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">⚙️ {isZh ? '通用设置' : 'General Settings'}</h3>
                <div className="tg-settings-switch-row">
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {isZh ? '按 Enter 发送消息' : 'Send Messages with Enter'}
                    </div>
                    <div className="tg-ai-workspace__subtitle">
                      {isZh ? '关闭后使用 Ctrl/Cmd+Enter 发送' : 'Disable to use Ctrl/Cmd+Enter'}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={sendByEnter}
                    aria-label="Send Messages with Enter"
                    className="tg-settings-switch"
                    onClick={() => setSendByEnter(!sendByEnter)}
                  />
                </div>

                <div className="tg-settings-switch-row">
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {isZh ? '自动翻译外语消息' : 'Auto-Translate Messages'}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoTranslate}
                    aria-label="Auto-Translate Messages"
                    className="tg-settings-switch"
                    onClick={() => setAutoTranslate(!autoTranslate)}
                  />
                </div>

                <div className="tg-settings-switch-row">
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {isZh ? '使用 24 小时制本地时间' : 'Use 24-Hour Local Time'}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={extras.timeFormat24h}
                    aria-label="Use 24-Hour Local Time"
                    className="tg-settings-switch"
                    onClick={() => updateExtra('timeFormat24h', !extras.timeFormat24h)}
                  />
                </div>
              </div>
            )}

            {/* WALLPAPER */}
            {currentSection === 'wallpaper' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">🖼️ {isZh ? '聊天壁纸' : 'Chat Wallpaper'}</h3>
                <div className="tg-ai-grid">
                  {WALLPAPER_PRESETS.map((wp) => (
                    <button
                      key={wp.id}
                      type="button"
                      className={`tg-btn ${wallpaper === wp.id ? 'tg-btn--primary' : 'tg-btn--secondary'}`}
                      onClick={() => setWallpaper(wp.id)}
                    >
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          background: wp.previewCss,
                          display: 'inline-block',
                          marginRight: 6,
                        }}
                      />
                      {isZh ? wp.labelZh : wp.labelEn}
                    </button>
                  ))}
                </div>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '毛玻璃模糊效果' : 'Frosted Wallpaper Blur'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={wallpaperBlur}
                    aria-label="Frosted Wallpaper Blur"
                    className="tg-settings-switch"
                    onClick={() => setWallpaperBlur(!wallpaperBlur)}
                  />
                </div>
                <input
                  ref={wpFileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      if (typeof reader.result === 'string') {
                        setWallpaper(reader.result);
                      }
                    };
                    reader.readAsDataURL(file);
                  }}
                />
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={() => wpFileInputRef.current?.click()}
                >
                  {isZh ? '上传自定义壁纸' : 'Upload Custom Image'}
                </button>
              </div>
            )}

            {/* NOTIFICATIONS */}
            {currentSection === 'notifications' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  🔔 {isZh ? '通知与声音' : 'Notifications & Sounds'}
                </h3>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '开启桌面消息通知' : 'Enable Desktop Notifications'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={notificationsEnabled}
                    aria-label="Enable Desktop Notifications"
                    className="tg-settings-switch"
                    onClick={() => setNotificationsEnabled(!notificationsEnabled)}
                  />
                </div>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '消息提示音' : 'Notification Sound'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={extras.notifSound}
                    aria-label="Notification Sound"
                    className="tg-settings-switch"
                    onClick={() => {
                      const next = !extras.notifSound;
                      updateExtra('notifSound', next);
                      void updatePrivacy({ notifications_sound: next }).catch(() => undefined);
                    }}
                  />
                </div>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '通知中显示消息预览' : 'Show Message Preview'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={extras.notifPreview}
                    aria-label="Show Message Preview"
                    className="tg-settings-switch"
                    onClick={() => updateExtra('notifPreview', !extras.notifPreview)}
                  />
                </div>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '回应表情通知' : 'Reaction Notifications'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={extras.notifReactions}
                    aria-label="Reaction Notifications"
                    className="tg-settings-switch"
                    onClick={() => updateExtra('notifReactions', !extras.notifReactions)}
                  />
                </div>
              </div>
            )}

            {/* PRIVACY & SECURITY */}
            {currentSection === 'privacy' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">🛡️ {isZh ? '隐私与安全' : 'Privacy & Security'}</h3>
                <div className="tg-ai-row">
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={() => selectSection('vault')}
                  >
                    🔐 {isZh ? 'E2EE 保险库与设备同步' : 'E2EE Vault & Device Sync'}
                  </button>
                  <button
                    type="button"
                    data-testid="privacy-goto-passcode"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => selectSection('passcode')}
                  >
                    🔒 {isZh ? '本地密码锁' : 'Passcode Lock'}
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => selectSection('two_fa')}
                  >
                    🔑 {isZh ? '两步验证 (2FA)' : 'Two-Step Verification'}
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => selectSection('passkeys')}
                  >
                    🪪 Passkeys
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => selectSection('blocked_users')}
                  >
                    🚫 {isZh ? '黑名单' : 'Blocked Users'}
                  </button>
                </div>

                {(
                  [
                    ['last_seen_privacy', isZh ? '最后上线时间' : 'Last Seen & Online'],
                    ['photo_privacy', isZh ? '个人头像可见范围' : 'Profile Photos'],
                    ['calls_privacy', isZh ? '谁可以向我发起通话' : 'Voice & Video Calls'],
                    ['forwards_privacy', isZh ? '转发消息关联账号' : 'Forwarded Messages'],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field} className="tg-ai-field">
                    <span>{label}</span>
                    <select
                      value={String(privacySettings?.[field] ?? 'everybody')}
                      onChange={(e) => void updatePrivacy({ [field]: e.target.value })}
                    >
                      {PRIVACY_LEVELS.map((lvl) => (
                        <option key={lvl.value} value={lvl.value}>
                          {isZh ? lvl.labelZh : lvl.labelEn}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}

                <div className="tg-ai-card tg-ai-card--elevated" style={{ marginTop: 8 }}>
                  <strong style={{ color: 'var(--tg-danger)' }}>
                    ⚠️ {isZh ? '永久注销账号' : 'Delete Account'}
                  </strong>
                  <div className="tg-ai-workspace__subtitle">
                    {isZh
                      ? '永久删除服务器上的账号、会话及加密保险库数据（不可撤销）。'
                      : 'Permanently delete your account, active sessions, and vault data on the server.'}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            isZh
                              ? '确认永久注销当前账号？此操作无法撤销。'
                              : 'Permanently delete your account? This cannot be undone.',
                          )
                        ) {
                          return;
                        }
                        try {
                          await deleteAccount();
                          closeSettings();
                        } catch (err) {
                          pushToast(err instanceof Error ? err.message : String(err), 'error');
                        }
                      }}
                    >
                      {isZh ? '删除账号' : 'Delete Account'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* E2EE VAULT & X25519 DEVICE TRUST RING (#vault-settings-panel) */}
            {currentSection === 'vault' && (
              <section id={DOM_IDS.VAULT_SETTINGS_PANEL} className="tg-vault-panel">
                <div className="tg-ai-card">
                  <div className="tg-ai-card__header">
                    <h3 className="tg-ai-card__title">
                      🔐 {isZh ? 'Split-Key V2 零知识端到端保险库' : 'Split-Key V2 E2EE User Vault'}
                    </h3>
                    <button
                      type="button"
                      className="tg-btn tg-btn--ghost"
                      onClick={() => void loadVaultState()}
                    >
                      ↻ {isZh ? '刷新' : 'Refresh'}
                    </button>
                  </div>

                  {vaultError && (
                    <div role="alert" className="tg-secret-leak-alert">
                      {vaultError}
                    </div>
                  )}
                  {vaultNotice && (
                    <div className="tg-ai-badge tg-ai-badge--success">{vaultNotice}</div>
                  )}

                  {/* Envelope Status */}
                  <div className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-row tg-ai-row--between">
                      <strong>{isZh ? '主密钥信封状态' : 'Key Envelope Status'}</strong>
                      <span
                        className={`tg-ai-badge ${
                          vaultEnvelope ? 'tg-ai-badge--success' : 'tg-ai-badge--warning'
                        }`}
                      >
                        {vaultEnvelope
                          ? `${vaultEnvelope.kdf_alg} · v${vaultEnvelope.key_version}`
                          : 'Not Initialized · 未初始化'}
                      </span>
                    </div>
                    {vaultEnvelope ? (
                      <div className="tg-ai-workspace__subtitle">
                        KDF: <code>{vaultEnvelope.kdf_alg}</code> · Argon2id m=
                        {vaultEnvelope.kdf_m_cost_kib} KiB / t={vaultEnvelope.kdf_t_cost} / p=
                        {vaultEnvelope.kdf_p_cost} · Recovery Wrap:{' '}
                        {vaultEnvelope.recovery_wrapped_root_key_b64 ? 'Configured' : 'None'}
                      </div>
                    ) : (
                      <div className="tg-ai-workspace__subtitle">
                        {isZh
                          ? '尚未上传 E2EE 主密钥信封。在下方输入口令以在客户端 WebCrypto 生成并封装主密钥。'
                          : 'No E2EE key envelope stored yet. Enter a passphrase below to wrap a client-side root key.'}
                      </div>
                    )}

                    <form onSubmit={(e) => void handleInitVaultEnvelope(e)} className="tg-ai-row">
                      <input
                        type="password"
                        value={vaultInitPassword}
                        onChange={(e) => setVaultInitPassword(e.target.value)}
                        placeholder={
                          isZh
                            ? '输入主密码生成/更新 Split-Key V2 密钥信封'
                            : 'Master passphrase to initialize/update split_key_v2 envelope'
                        }
                        style={{
                          flex: 1,
                          background: 'var(--tg-bg-input)',
                          color: 'var(--tg-text-primary)',
                          border: '1px solid var(--tg-border)',
                          borderRadius: 8,
                          padding: '7px 10px',
                          fontSize: 12,
                        }}
                      />
                      <button
                        type="submit"
                        className="tg-btn tg-btn--primary"
                        disabled={vaultBusy}
                      >
                        {isZh ? '初始化/更新信封' : 'Save Envelope'}
                      </button>
                    </form>
                  </div>

                  {/* Vault Items Revision Summary */}
                  <div className="tg-ai-card tg-ai-card--elevated">
                    <div className="tg-ai-row tg-ai-row--between">
                      <strong>{isZh ? '加密保险库同步项' : 'Encrypted Vault Items'}</strong>
                      <span className="tg-ai-badge tg-ai-badge--info">
                        Revision #{vaultLatestRevision}
                      </span>
                    </div>
                    <div className="tg-ai-row">
                      <span className="tg-ai-badge">password: {vaultPasswordCount}</span>
                      <span className="tg-ai-badge">browser_cookie: {vaultCookieCount}</span>
                      <span className="tg-ai-badge">ai_oauth: {vaultOAuthCount}</span>
                    </div>
                  </div>
                </div>

                {/* X25519 Device Trust Ring */}
                <div className="tg-ai-card">
                  <div className="tg-ai-card__header">
                    <h3 className="tg-ai-card__title">
                      📱 {isZh ? 'X25519 设备信任环同步' : 'X25519 Device Trust Ring'}
                    </h3>
                  </div>

                  <div className="tg-ai-row">
                    <input
                      type="text"
                      value={syncDeviceName}
                      onChange={(e) => setSyncDeviceName(e.target.value)}
                      placeholder="Device name"
                      style={{
                        flex: 1,
                        background: 'var(--tg-bg-input)',
                        color: 'var(--tg-text-primary)',
                        border: '1px solid var(--tg-border)',
                        borderRadius: 8,
                        padding: '7px 10px',
                        fontSize: 12,
                      }}
                    />
                    <button
                      type="button"
                      className="tg-btn tg-btn--primary"
                      disabled={vaultBusy}
                      onClick={() => void handleRequestDeviceSync()}
                    >
                      {isZh ? '发起新设备同步 (NNN-NNN)' : 'Request Device Sync (NNN-NNN)'}
                    </button>
                  </div>

                  {activeDeviceSyncRequest && (
                    <div className="tg-ai-card tg-ai-card--elevated">
                      <span className="tg-ai-workspace__subtitle">
                        {isZh
                          ? '在已信任设备上核对此 6 位验证码后点击批准：'
                          : 'Confirm this 6-digit code on your trusted device:'}
                      </span>
                      <div className="tg-device-sync-code">
                        {activeDeviceSyncRequest.verification_code}
                      </div>
                      <div className="tg-ai-workspace__subtitle">
                        Request ID: <code>{activeDeviceSyncRequest.request_id}</code>
                      </div>
                    </div>
                  )}

                  <strong style={{ fontSize: 13 }}>
                    {isZh ? '待审批设备同步请求' : 'Pending Device Sync Requests'} (
                    {pendingDeviceSyncs.length})
                  </strong>

                  {pendingDeviceSyncs.length === 0 ? (
                    <div className="tg-ai-empty">
                      {isZh ? '暂无待审批的新设备同步请求' : 'No pending device sync requests'}
                    </div>
                  ) : (
                    <div className="tg-ai-grid">
                      {pendingDeviceSyncs.map((item) => (
                        <div key={item.request_id} className="tg-ai-card tg-ai-card--elevated">
                          <div className="tg-ai-row tg-ai-row--between">
                            <strong>{item.device_name}</strong>
                            <span className="tg-ai-badge tg-ai-badge--accent">
                              {item.verification_code}
                            </span>
                          </div>
                          <div className="tg-ai-workspace__subtitle">
                            ID: <code>{item.request_id}</code> · Status: {item.status}
                          </div>
                          <div className="tg-ai-row">
                            <button
                              type="button"
                              className="tg-btn tg-btn--primary"
                              disabled={vaultBusy}
                              onClick={() => void handleApproveDeviceSync(item)}
                            >
                              {isZh ? '批准同步' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              className="tg-btn tg-btn--danger"
                              disabled={vaultBusy}
                              onClick={() => void denyDeviceSync(item.request_id)}
                            >
                              {isZh ? '拒绝' : 'Deny'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Split-Key V2 Upgrade & Password Rotation */}
                <div className="tg-ai-card">
                  <h4 className="tg-ai-card__title">
                    🔄 {isZh ? 'Split-Key V2 账号托管升级与密钥轮换' : 'Split-Key V2 Custody Upgrade & Rotation'}
                  </h4>
                  <div className="tg-ai-row">
                    <input
                      type="password"
                      value={upgradeOldPwd}
                      onChange={(e) => setUpgradeOldPwd(e.target.value)}
                      placeholder={isZh ? '当前密码 (升级 V1 → Split-Key V2)' : 'Current password (upgrade V1 -> V2)'}
                      style={{
                        flex: 1,
                        background: 'var(--tg-bg-input)',
                        color: 'var(--tg-text-primary)',
                        border: '1px solid var(--tg-border)',
                        borderRadius: 8,
                        padding: '7px 10px',
                        fontSize: 12,
                      }}
                    />
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      disabled={!upgradeOldPwd}
                      onClick={async () => {
                        setVaultError(null);
                        try {
                          await upgradeSplitKey(upgradeOldPwd);
                          setUpgradeOldPwd('');
                          setVaultNotice('Account upgraded to Split-Key V2 zero-knowledge auth');
                        } catch (err) {
                          setVaultError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      {isZh ? '升级为 V2' : 'Upgrade to V2'}
                    </button>
                  </div>

                  <div className="tg-ai-row">
                    <input
                      type="password"
                      value={rotateOldSecret}
                      onChange={(e) => setRotateOldSecret(e.target.value)}
                      placeholder={isZh ? '旧密码' : 'Current password'}
                      style={{
                        flex: 1,
                        background: 'var(--tg-bg-input)',
                        color: 'var(--tg-text-primary)',
                        border: '1px solid var(--tg-border)',
                        borderRadius: 8,
                        padding: '7px 10px',
                        fontSize: 12,
                      }}
                    />
                    <input
                      type="password"
                      value={rotateNewPwd}
                      onChange={(e) => setRotateNewPwd(e.target.value)}
                      placeholder={isZh ? '新密码' : 'New password'}
                      style={{
                        flex: 1,
                        background: 'var(--tg-bg-input)',
                        color: 'var(--tg-text-primary)',
                        border: '1px solid var(--tg-border)',
                        borderRadius: 8,
                        padding: '7px 10px',
                        fontSize: 12,
                      }}
                    />
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      disabled={!rotateOldSecret || !rotateNewPwd}
                      onClick={async () => {
                        setVaultError(null);
                        try {
                          await changePassword(rotateOldSecret, rotateNewPwd);
                          setRotateOldSecret('');
                          setRotateNewPwd('');
                          setVaultNotice('Password rotated cleanly with Split-Key V2 verifier');
                        } catch (err) {
                          setVaultError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      {isZh ? '更改密码' : 'Change Password'}
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* LOCAL PASSCODE LOCK */}
            {currentSection === 'passcode' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">🔒 {isZh ? '本地密码锁' : 'Local Passcode Lock'}</h3>
                <div className="tg-ai-workspace__subtitle">
                  Status: <strong>{passcodeHash ? 'Enabled · 已启用' : 'Disabled · 未启用'}</strong>
                </div>
                <div className="tg-ai-row">
                  <input
                    type="password"
                    value={passcodeInput}
                    onChange={(e) => setPasscodeInput(e.target.value)}
                    placeholder={isZh ? '输入 4+ 位锁屏密码' : 'Enter 4+ char passcode'}
                    style={{
                      flex: 1,
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: '8px 10px',
                    }}
                  />
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={async () => {
                      if (passcodeInput.length < 4) {
                        pushToast('Passcode must be at least 4 characters', 'warning');
                        return;
                      }
                      await setPasscode(passcodeInput);
                      setPasscodeInput('');
                      pushToast('Local passcode enabled', 'success');
                    }}
                  >
                    {isZh ? '设置密码' : 'Set Passcode'}
                  </button>
                </div>
                {passcodeHash && (
                  <div className="tg-ai-row">
                    <button type="button" className="tg-btn tg-btn--secondary" onClick={lockApp}>
                      🔒 {isZh ? '立即锁定' : 'Lock Now'}
                    </button>
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={() => void clearPasscode()}
                    >
                      {isZh ? '关闭密码锁' : 'Disable Passcode'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* TWO-STEP VERIFICATION (2FA) */}
            {currentSection === 'two_fa' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  🔑 {isZh ? '两步验证云密码 (Cloud 2FA)' : 'Two-Step Verification (Cloud 2FA)'}
                </h3>
                <div className="tg-ai-workspace__subtitle">
                  Status:{' '}
                  <strong>{twoFaStatus?.enabled ? 'Enabled · 已开启' : 'Disabled · 未开启'}</strong>
                  {twoFaStatus?.hint ? ` · Hint: ${twoFaStatus.hint}` : ''}
                </div>
                <div className="tg-ai-field-grid">
                  {twoFaStatus?.enabled && (
                    <label className="tg-ai-field">
                      <span>{isZh ? '当前云密码' : 'Current 2FA Password'}</span>
                      <input
                        type="password"
                        value={twoFaCurrentPwd}
                        onChange={(e) => setTwoFaCurrentPwd(e.target.value)}
                      />
                    </label>
                  )}
                  <label className="tg-ai-field">
                    <span>{isZh ? '新云密码' : 'New 2FA Password'}</span>
                    <input
                      type="password"
                      value={twoFaNewPwd}
                      onChange={(e) => setTwoFaNewPwd(e.target.value)}
                    />
                  </label>
                  <label className="tg-ai-field">
                    <span>{isZh ? '密码提示' : 'Password Hint'}</span>
                    <input
                      type="text"
                      value={twoFaHintInput}
                      onChange={(e) => setTwoFaHintInput(e.target.value)}
                    />
                  </label>
                  <label className="tg-ai-field">
                    <span>{isZh ? '恢复邮箱 (可选)' : 'Recovery Email (Optional)'}</span>
                    <input
                      type="email"
                      value={twoFaEmailInput}
                      onChange={(e) => setTwoFaEmailInput(e.target.value)}
                    />
                  </label>
                </div>
                <div className="tg-ai-row">
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    disabled={!twoFaNewPwd.trim()}
                    onClick={async () => {
                      try {
                        await set2faPassword({
                          currentPassword: twoFaCurrentPwd || undefined,
                          newPassword: twoFaNewPwd,
                          hint: twoFaHintInput || undefined,
                          recoveryEmail: twoFaEmailInput || undefined,
                        });
                        setTwoFaCurrentPwd('');
                        setTwoFaNewPwd('');
                        pushToast('Cloud 2FA password updated', 'success');
                      } catch (err) {
                        pushToast(err instanceof Error ? err.message : String(err), 'error');
                      }
                    }}
                  >
                    {isZh ? '保存两步验证密码' : 'Save 2FA Password'}
                  </button>
                  {twoFaStatus?.enabled && (
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={async () => {
                        try {
                          await disable2faPassword(twoFaCurrentPwd || undefined);
                          setTwoFaCurrentPwd('');
                          pushToast('Cloud 2FA disabled', 'info');
                        } catch (err) {
                          pushToast(err instanceof Error ? err.message : String(err), 'error');
                        }
                      }}
                    >
                      {isZh ? '关闭两步验证' : 'Disable 2FA'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* SERVER-BACKED PASSKEYS (WebAuthn COSE) */}
            {currentSection === 'passkeys' && (
              <div className="tg-ai-card">
                <div className="tg-ai-card__header">
                  <h3 className="tg-ai-card__title">
                    🪪 {isZh ? '通行密钥 (服务器验证 WebAuthn)' : 'Passkeys (Server-Verified WebAuthn)'}
                  </h3>
                  <button
                    type="button"
                    className="tg-btn tg-btn--ghost"
                    onClick={() => void loadAccountPasskeys()}
                  >
                    ↻ Refresh
                  </button>
                </div>

                <div className="tg-ai-row">
                  <input
                    type="text"
                    value={passkeyLabel}
                    onChange={(e) => setPasskeyLabel(e.target.value)}
                    placeholder="Passkey label"
                    style={{
                      flex: 1,
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: '8px 10px',
                    }}
                  />
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    disabled={passkeyBusy}
                    onClick={async () => {
                      setPasskeyBusy(true);
                      try {
                        await registerPasskey(passkeyLabel.trim() || 'Fabushi Web Passkey');
                        await loadAccountPasskeys();
                        pushToast('Passkey registered on server', 'success');
                      } catch (err) {
                        pushToast(err instanceof Error ? err.message : String(err), 'error');
                      } finally {
                        setPasskeyBusy(false);
                      }
                    }}
                  >
                    {passkeyBusy ? 'Registering…' : '+ Register Passkey · 注册密钥'}
                  </button>
                </div>

                {accountPasskeys.length === 0 ? (
                  <div className="tg-ai-empty">
                    {isZh ? '当前账号尚未注册任何通行密钥。' : 'No WebAuthn passkeys registered yet.'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {accountPasskeys.map((pk) => (
                      <div key={pk.cred_id} className="tg-ai-card tg-ai-card--elevated">
                        <div className="tg-ai-row tg-ai-row--between">
                          <div>
                            <strong>{pk.label}</strong>
                            <div className="tg-ai-workspace__subtitle">
                              ID: <code>{pk.cred_id.slice(0, 18)}…</code> · Created:{' '}
                              {new Date(pk.created_at_ms).toLocaleDateString()}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="tg-btn tg-btn--danger"
                            onClick={() => void deleteAccountPasskey(pk.cred_id)}
                          >
                            {isZh ? '删除' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* BLOCKED USERS */}
            {currentSection === 'blocked_users' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  🚫 {isZh ? '黑名单管理' : 'Blocked Users'} ({blockedUsers.length})
                </h3>
                {blockedUsers.length === 0 ? (
                  <div className="tg-ai-empty">
                    {isZh ? '暂无已屏蔽的联系人' : 'No blocked users.'}
                  </div>
                ) : (
                  blockedUsers.map((u) => (
                    <div key={u.userId} className="tg-ai-row tg-ai-row--between">
                      <span>
                        {u.firstName} {u.lastName ?? ''} {u.username ? `(@${u.username})` : ''}
                      </span>
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void toggleBlockUser(u.userId, false)}
                      >
                        {isZh ? '解除屏蔽' : 'Unblock'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* AUTO DELETE */}
            {currentSection === 'auto_delete' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  ⏱️ {isZh ? '全局自动删除计时器' : 'Global Auto-Delete Messages'}
                </h3>
                <div className="tg-ai-row">
                  {GLOBAL_TTL_OPTIONS.map((opt) => (
                    <button
                      key={opt.seconds}
                      type="button"
                      className={`tg-btn ${
                        globalTtl === opt.seconds ? 'tg-btn--primary' : 'tg-btn--secondary'
                      }`}
                      onClick={() => {
                        setGlobalTtl(opt.seconds);
                        void updatePrivacy({ global_ttl_seconds: opt.seconds }).catch(
                          () => undefined,
                        );
                      }}
                    >
                      {isZh ? opt.labelZh : opt.labelEn}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* CHAT FOLDERS */}
            {currentSection === 'folders' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  📁 {isZh ? '会话分组文件夹' : 'Chat Folders'} ({folders.length})
                </h3>
                <div className="tg-ai-row">
                  <input
                    type="text"
                    value={newFolderEmoji}
                    onChange={(e) => setNewFolderEmoji(e.target.value)}
                    style={{
                      width: 48,
                      textAlign: 'center',
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: 7,
                    }}
                  />
                  <input
                    type="text"
                    value={newFolderTitle}
                    onChange={(e) => setNewFolderTitle(e.target.value)}
                    placeholder={isZh ? '新文件夹名称' : 'New folder name'}
                    style={{
                      flex: 1,
                      background: 'var(--tg-bg-input)',
                      color: 'var(--tg-text-primary)',
                      border: '1px solid var(--tg-border)',
                      borderRadius: 8,
                      padding: '7px 10px',
                    }}
                  />
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    disabled={!newFolderTitle.trim()}
                    onClick={async () => {
                      await upsertFolder({
                        title: newFolderTitle.trim(),
                        emoticon: newFolderEmoji.trim() || '📁',
                      });
                      setNewFolderTitle('');
                    }}
                  >
                    + {isZh ? '创建' : 'Create'}
                  </button>
                </div>
                {folders.map((f) => (
                  <div key={String(f.id)} className="tg-ai-row tg-ai-row--between">
                    <span>
                      {f.emoticon ?? '📁'} {f.title}
                    </span>
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger"
                      onClick={() => void deleteFolder(f.id)}
                    >
                      {isZh ? '删除' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* DEVICES & ACTIVE SESSIONS (strictly truthful server IP or omitted when empty) */}
            {currentSection === 'devices' && (
              <div className="tg-ai-card">
                <div className="tg-ai-card__header">
                  <h3 className="tg-ai-card__title">
                    💻 {isZh ? '登录设备与活跃会话' : 'Devices & Active Sessions'} (
                    {activeSessions.length})
                  </h3>
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger"
                    onClick={async () => {
                      const count = await revokeOtherSessions();
                      pushToast(`Revoked ${count} other session(s)`, 'info');
                    }}
                  >
                    {isZh ? '注销其他所有设备' : 'Terminate Other Sessions'}
                  </button>
                </div>

                {activeSessions.length === 0 ? (
                  <div className="tg-ai-empty">
                    {isZh ? '暂无活跃设备记录' : 'No active sessions found.'}
                  </div>
                ) : (
                  activeSessions.map((sess) => {
                    const cleanIp = typeof sess.ip_address === 'string' ? sess.ip_address.trim() : '';
                    return (
                      <div key={sess.session_id} className="tg-ai-card tg-ai-card--elevated">
                        <div className="tg-ai-row tg-ai-row--between">
                          <div>
                            <strong>{sess.device_name || 'Fabushi Web Session'}</strong>
                            <div className="tg-ai-workspace__subtitle">
                              {sess.is_current
                                ? isZh
                                  ? '当前设备'
                                  : 'Current device'
                                : isZh
                                  ? '在线设备'
                                  : 'Active device'}
                              {cleanIp ? ` · ${cleanIp}` : ''}
                            </div>
                          </div>
                          {!sess.is_current && (
                            <button
                              type="button"
                              className="tg-btn tg-btn--danger"
                              onClick={() => void revokeSession(sess.session_id)}
                            >
                              {isZh ? '踢下线' : 'Revoke'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* DATA & STORAGE */}
            {currentSection === 'data_storage' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">💾 {isZh ? '数据与存储' : 'Data & Storage'}</h3>
                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={async () => {
                    await indexedDbCache.clearAll();
                    setCacheClearedAt(new Date().toLocaleTimeString());
                    pushToast('IndexedDB cache cleared', 'success');
                  }}
                >
                  🧹 {isZh ? '清理本地 IndexedDB 缓存' : 'Clear Local IndexedDB Cache'}
                </button>
                {cacheClearedAt && (
                  <div className="tg-ai-workspace__subtitle">Cleared at {cacheClearedAt}</div>
                )}
              </div>
            )}

            {/* LANGUAGE */}
            {currentSection === 'language' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">🌐 {isZh ? '界面语言' : 'Language'}</h3>
                <div className="tg-ai-row">
                  {(
                    [
                      ['en-US', 'English (en-US)'],
                      ['zh-CN', '简体中文 (zh-CN)'],
                    ] as Array<[LocaleCode, string]>
                  ).map(([code, label]) => (
                    <button
                      key={code}
                      type="button"
                      className={`tg-btn ${language === code ? 'tg-btn--primary' : 'tg-btn--secondary'}`}
                      onClick={() => setLanguage(code)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* STICKERS & EMOJI (Truthful empty state — ZERO fabricated vector sticker text!) */}
            {currentSection === 'stickers' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  😊 {isZh ? '贴纸与表情包' : 'Stickers & Emoji'} ({stickerSets.length})
                </h3>
                {stickerSets.length === 0 ? (
                  <div className="tg-ai-empty">
                    {isZh ? '暂无已安装的贴纸包' : 'No sticker packs installed yet.'}
                  </div>
                ) : (
                  stickerSets.map((set) => (
                    <div key={set.set_id} className="tg-ai-row tg-ai-row--between">
                      <span>
                        {set.title} ({set.stickers.length})
                      </span>
                      <button
                        type="button"
                        className="tg-btn tg-btn--secondary"
                        onClick={() => void installStickerSet(set.set_id, !set.is_installed)}
                      >
                        {set.is_installed ? (isZh ? '移除' : 'Remove') : isZh ? '安装' : 'Install'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* POWER SAVING (Persisted Switches) */}
            {currentSection === 'power_saving' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">🔋 {isZh ? '省电模式' : 'Power Saving'}</h3>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '减少动画与过渡效果' : 'Reduce Motion & Transitions'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={powerSaving}
                    aria-label="Reduce Motion"
                    className="tg-settings-switch"
                    onClick={() => setPowerSaving(!powerSaving)}
                  />
                </div>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '自动播放 GIF' : 'Autoplay GIFs'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={extras.autoplayGifs}
                    aria-label="Autoplay GIFs"
                    className="tg-settings-switch"
                    onClick={() => updateExtra('autoplayGifs', !extras.autoplayGifs)}
                  />
                </div>
                <div className="tg-settings-switch-row">
                  <span>{isZh ? '自动播放视频' : 'Autoplay Videos'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={extras.autoplayVideos}
                    aria-label="Autoplay Videos"
                    className="tg-settings-switch"
                    onClick={() => updateExtra('autoplayVideos', !extras.autoplayVideos)}
                  />
                </div>
              </div>
            )}

            {/* CHAT EXPORT */}
            {currentSection === 'chat_export' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">📦 {isZh ? '导出聊天记录' : 'Export Chat History'}</h3>
                <label className="tg-ai-field">
                  <span>{isZh ? '选择会话' : 'Select Chat'}</span>
                  <select
                    value={exportChatId ?? ''}
                    onChange={(e) => setExportChatId(Number(e.target.value) || null)}
                  >
                    {orderedChatIds.length === 0 ? (
                      <option value="">{isZh ? '暂无会话' : 'No chats available'}</option>
                    ) : (
                      orderedChatIds.map((cid) => (
                        <option key={cid} value={cid}>
                          {chatsById[cid]?.title || `Chat #${cid}`}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <div className="tg-ai-row">
                  <button
                    id={DOM_IDS.BTN_EXPORT_CHAT_JSON}
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={() => void handleExport('json')}
                  >
                    Download JSON
                  </button>
                  <button
                    id={DOM_IDS.BTN_EXPORT_CHAT_HTML}
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => void handleExport('html')}
                  >
                    Download HTML
                  </button>
                </div>
              </div>
            )}

            {/* SERVER CONNECTION (Real HTTP/WS Backend Only) */}
            {currentSection === 'connection_mode' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">🔌 {isZh ? '服务器连接配置' : 'Server Connection'}</h3>
                <label className="tg-ai-field">
                  <span>{isZh ? '后端服务 URL (留空使用同源服务)' : 'Backend Server URL (blank for Same Origin)'}</span>
                  <input
                    type="text"
                    value={serverUrlDraft}
                    onChange={(e) => setServerUrlDraft(e.target.value)}
                    placeholder="https://web.ombhrum.com"
                  />
                </label>
                <div className="tg-ai-row">
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => {
                      setServerUrlDraft('');
                      setServerUrl('');
                    }}
                  >
                    Same Origin · 同源
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={() => {
                      setServerUrlDraft('https://web.ombhrum.com');
                      setServerUrl('https://web.ombhrum.com');
                    }}
                  >
                    web.ombhrum.com
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={async () => {
                      setServerUrl(serverUrlDraft.trim());
                      const snap = await probeServerHealth(serverUrlDraft.trim());
                      pushToast(
                        snap.status === 'online'
                          ? `Online (${snap.version || '1.6.11'})`
                          : `Offline: ${snap.error || 'unreachable'}`,
                        snap.status === 'online' ? 'success' : 'error',
                      );
                    }}
                  >
                    {isZh ? '保存并检测连通性' : 'Save & Test Connection'}
                  </button>
                </div>
                <div className="tg-ai-workspace__subtitle">
                  Health: <strong>{serverHealth.status}</strong>
                  {serverHealth.version ? ` · v${serverHealth.version}` : ''}
                </div>
              </div>
            )}

            {/* MAGPIE LLM GATEWAY — Embedded Directly on First Click! */}
            {currentSection === 'magpie_gateway' && <MagpieGatewayPanel embedded />}

            {/* FABUSHI / HERMES STUDIO SHORTCUT */}
            {currentSection === 'hermes_studio' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">⚡ Fabushi / Hermes AI Studio</h3>
                <p className="tg-ai-workspace__subtitle" style={{ margin: 0 }}>
                  {isZh
                    ? '统一管理会话、记忆、技能、工具集、定时任务、审批看板、Coding Agent Bots 与多智能体协作。'
                    : 'Unified workspace for sessions, memory, skills, toolsets, cron jobs, approvals, Coding Agent Bots, and Multi-Agent workspaces.'}
                </p>
                <button
                  type="button"
                  className="tg-btn tg-btn--primary"
                  onClick={() => {
                    closeSettings();
                    setActiveNavDest('hermes');
                  }}
                >
                  ⚡ {isZh ? '进入智能体工作台' : 'Open Fabushi / Hermes Studio'}
                </button>
              </div>
            )}

            {/* BROWSER CONTROL SHORTCUT */}
            {currentSection === 'browser_control' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">🌐 Built-in Browser & Automation App Store</h3>
                <div className="tg-ai-workspace__subtitle">
                  Target: <code>{localBridgeState.targetId}</code> · Generation #
                  {localBridgeState.controlGeneration}
                  {pairingTicket ? ` · Pair Code: ${pairingTicket.pair_code}` : ''}
                </div>
                <button
                  type="button"
                  className="tg-btn tg-btn--primary"
                  onClick={() => {
                    closeSettings();
                    setActiveNavDest('browser_control');
                  }}
                >
                  🌐 {isZh ? '打开内置浏览器工作台' : 'Open Built-in Browser Workspace'}
                </button>
              </div>
            )}

            {/* WALLET */}
            {currentSection === 'wallet' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">⭐ Stars & TON Wallet</h3>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--tg-warning)' }}>
                  ★ {Number(wallet?.stars_balance ?? wallet?.balance ?? 0)} Stars
                </div>
                <button
                  type="button"
                  className="tg-btn tg-btn--primary"
                  onClick={() => {
                    closeSettings();
                    openModal('wallet_stars');
                  }}
                >
                  ⭐ {isZh ? '打开星币钱包弹窗' : 'Open Stars & TON Wallet'}
                </button>
              </div>
            )}

            {/* ABOUT & SHORTCUTS (Fabushi Web v1.6.11 Branding) */}
            {currentSection === 'about' && (
              <div className="tg-ai-card">
                <h3 className="tg-ai-card__title">
                  ℹ️ {isZh ? '法布施 Web · v1.6.11' : 'Fabushi Web · v1.6.11'}
                </h3>
                <p className="tg-ai-workspace__subtitle" style={{ margin: 0, lineHeight: 1.6 }}>
                  {isZh
                    ? '全面对齐桌面端 Fabushi v1.6.11 的生产级全栈 Web 客户端：零假数据架构、Split-Key V2 零知识端到端保险库与 X25519 设备信任环、Apple Messages & Muse 无紫暗色设计、每用户 ChaCha20 加密隔离 Magpie v1.6 与实时 models.dev 目录、统一 Fabushi/Hermes 智能体与 Coding Agent Bots、官方 OAuth 2.1 远程 MCP (/mcp)、UU 级远程协助、内置 Chromium 浏览器脚本蒸馏与自动化应用商店，以及 3D 法布施 WASM + WebMCP 小程序。'
                    : 'Production full-stack web edition aligned 100% with desktop Fabushi v1.6.11: zero fake data, Split-Key V2 E2EE User Vault & X25519 Device Trust Ring, Apple Messages & Muse zero-purple design, per-user ChaCha20-encrypted Magpie v1.6 + live models.dev catalog, unified Fabushi/Hermes Multi-Agent runtime & Coding Agent Bots, Official OAuth 2.1 Remote MCP (/mcp), UU-Parity Remote Assist, Built-in Chromium Browser Script Distillation & Automation App Store, and 3D Fabushi WASM + WebMCP Mini Apps.'}
                </p>
                <div className="tg-ai-row">
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={openShortcutsModalImperatively}
                  >
                    ⌨️ {isZh ? '查看键盘快捷键 (?)' : 'Keyboard Shortcuts (?)'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};

export default SettingsPanel;
