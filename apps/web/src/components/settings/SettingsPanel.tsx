import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DATA_ATTRS,
  DOM_IDS,
  peerAvatarColorIndex,
  type AdapterMode,
  type ChatFolder,
} from '@gpui-telegram/protocol';
import { indexedDbCache } from '../../adapters';
import { t, type LocaleCode } from '../../i18n';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { isDemoUiEnabled, useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import {
  NON_PURPLE_ACCENT_SWATCHES,
  useSettingsStore,
  type ThemeName,
} from '../../store/useSettingsStore';
import {
  useUiStore,
  type ModalId,
  type SettingsSectionId,
} from '../../store/useUiStore';

export interface SettingsPanelProps {
  className?: string;
}

interface SectionDescriptor {
  id: Exclude<SettingsSectionId, 'root'>;
  icon: string;
  titleEn: string;
  titleZh: string;
  subtitleEn: string;
  subtitleZh: string;
}

const SETTINGS_SECTIONS: readonly SectionDescriptor[] = [
  {
    id: 'edit_profile',
    icon: '👤',
    titleEn: 'Edit Profile',
    titleZh: '编辑个人资料',
    subtitleEn: 'Name, bio, @username',
    subtitleZh: '姓名、简介与 @用户名',
  },
  {
    id: 'appearance',
    icon: '🎨',
    titleEn: 'Appearance & Themes',
    titleZh: '外观与主题',
    subtitleEn: 'Night, Tinted, Day, Classic, accents & sliders',
    subtitleZh: '四套主题、强调色、字号与气泡圆角',
  },
  {
    id: 'general',
    icon: '⚙️',
    titleEn: 'General Settings',
    titleZh: '通用设置',
    subtitleEn: 'Send key, auto-translate, time format',
    subtitleZh: '发送快捷键、自动翻译与时间格式',
  },
  {
    id: 'wallpaper',
    icon: '🖼️',
    titleEn: 'Chat Wallpaper',
    titleZh: '聊天壁纸',
    subtitleEn: 'Vector gradients, custom image & frosted blur',
    subtitleZh: '渐变壁纸、自定义上传与毛玻璃模糊',
  },
  {
    id: 'notifications',
    icon: '🔔',
    titleEn: 'Notifications and Sounds',
    titleZh: '通知与声音',
    subtitleEn: 'Desktop alerts, sound & message preview',
    subtitleZh: '桌面提醒、提示音与消息预览',
  },
  {
    id: 'privacy',
    icon: '🛡️',
    titleEn: 'Privacy and Security',
    titleZh: '隐私与安全',
    subtitleEn: 'Last seen, calls, forwards & security overview',
    subtitleZh: '在线状态、通话、转发权限与安全概览',
  },
  {
    id: 'passcode',
    icon: '🔐',
    titleEn: 'Local Passcode Lock',
    titleZh: '本地密码锁',
    subtitleEn: 'PIN lock & Ctrl+Shift+L instant lock',
    subtitleZh: '本地锁屏密码与 Ctrl+Shift+L 快捷锁定',
  },
  {
    id: 'two_fa',
    icon: '🔑',
    titleEn: 'Two-Step Verification (2FA)',
    titleZh: '两步验证云密码',
    subtitleEn: 'Cloud password, hint & recovery email',
    subtitleZh: '云端二次验证密码、提示与恢复邮箱',
  },
  {
    id: 'passkeys',
    icon: '🪪',
    titleEn: 'Passkeys (WebAuthn)',
    titleZh: '通行密钥 (Passkeys)',
    subtitleEn: 'Hardware & biometric passwordless sign-in',
    subtitleZh: '生物识别与硬件密钥免密登录',
  },
  {
    id: 'blocked_users',
    icon: '🚫',
    titleEn: 'Blocked Users',
    titleZh: '黑名单管理',
    subtitleEn: 'View and unblock restricted peers',
    subtitleZh: '查看或解除已屏蔽的联系人',
  },
  {
    id: 'auto_delete',
    icon: '⏱️',
    titleEn: 'Global Auto-Delete Messages',
    titleZh: '全局自动删除计时器',
    subtitleEn: 'Default self-destruct timer for new chats',
    subtitleZh: '新会话默认消息自动销毁时长',
  },
  {
    id: 'folders',
    icon: '📁',
    titleEn: 'Chat Folders',
    titleZh: '会话分组文件夹',
    subtitleEn: 'Create, edit, reorder & delete folders',
    subtitleZh: '创建、编辑、排序与删除自定义分组',
  },
  {
    id: 'devices',
    icon: '💻',
    titleEn: 'Devices & Active Sessions',
    titleZh: '登录设备与会话',
    subtitleEn: 'Manage active logins & revoke sessions',
    subtitleZh: '管理在线设备并远程注销其他会话',
  },
  {
    id: 'data_storage',
    icon: '💾',
    titleEn: 'Data and Storage',
    titleZh: '数据与存储',
    subtitleEn: 'IndexedDB cache stats, clear cache & export',
    subtitleZh: '本地缓存统计、清理与记录导出',
  },
  {
    id: 'language',
    icon: '🌐',
    titleEn: 'Language',
    titleZh: '语言 (Language)',
    subtitleEn: 'English (en-US) / 简体中文 (zh-CN)',
    subtitleZh: '中英文界面实时热切换',
  },
  {
    id: 'stickers',
    icon: '😊',
    titleEn: 'Stickers and Emoji',
    titleZh: '贴纸与表情包',
    subtitleEn: 'Manage installed sticker packs',
    subtitleZh: '管理已安装的贴纸包',
  },
  {
    id: 'power_saving',
    icon: '🔋',
    titleEn: 'Power Saving',
    titleZh: '省电模式与动画',
    subtitleEn: 'Reduce motion, transitions & autoplay',
    subtitleZh: '减少动效、过渡动画与自动播放',
  },
  {
    id: 'chat_export',
    icon: '📦',
    titleEn: 'Export Chat History',
    titleZh: '导出聊天记录',
    subtitleEn: 'Download JSON & standalone HTML archives',
    subtitleZh: '导出 JSON 或独立排版 HTML 聊天归档',
  },
  {
    id: 'connection_mode',
    icon: '🔌',
    titleEn: 'Server Connection',
    titleZh: '服务器连接',
    subtitleEn: 'Configure backend server URL & health check',
    subtitleZh: '配置后端服务地址与连通性检测',
  },
  {
    id: 'magpie_gateway',
    icon: '🐦',
    titleEn: 'Magpie LLM Gateway',
    titleZh: 'Magpie 模型网关',
    subtitleEn: 'Multi-provider routing, probe & PII mask',
    subtitleZh: '多模型路由、连通性检测与隐私脱敏',
  },
  {
    id: 'hermes_studio',
    icon: '🤖',
    titleEn: 'Hermes AI Studio',
    titleZh: 'Hermes 智能工作台',
    subtitleEn: '6-tab agent sessions, memory, skills & cron',
    subtitleZh: '六栏智能体会话、记忆、技能与定时任务',
  },
  {
    id: 'browser_control',
    icon: '🧭',
    titleEn: 'Browser Control Bridge',
    titleZh: '浏览器接管桥接',
    subtitleEn: 'Desktop pairing ticket & emergency revoke',
    subtitleZh: '桌面端配对授权与一键紧急接管撤销',
  },
  {
    id: 'wallet',
    icon: '⭐',
    titleEn: 'Telegram Stars & Wallet',
    titleZh: '星币与 TON 钱包',
    subtitleEn: 'Stars balance, top-up & gifts ledger',
    subtitleZh: '星币余额充值、礼物的账单明细',
  },
  {
    id: 'about',
    icon: 'ℹ️',
    titleEn: 'About & Keyboard Shortcuts',
    titleZh: '关于与键盘快捷键',
    subtitleEn: 'GPUI Telegram Web v1.3.0 & shortcut cheatsheet',
    subtitleZh: '版本架构信息与全局快捷键一览',
  },
] as const;

const WALLPAPER_PRESETS: ReadonlyArray<{
  id: string;
  labelEn: string;
  labelZh: string;
  previewCss: string;
}> = [
  {
    id: 'default',
    labelEn: 'Midnight Slate',
    labelZh: '深海夜色',
    previewCss: 'linear-gradient(135deg, #0E1621 0%, #17212B 100%)',
  },
  {
    id: 'ocean',
    labelEn: 'Ocean Horizon',
    labelZh: '远洋微光',
    previewCss: 'linear-gradient(135deg, #0E1621 0%, #1B4978 100%)',
  },
  {
    id: 'emerald',
    labelEn: 'Emerald Pine',
    labelZh: '翡翠松林',
    previewCss: 'linear-gradient(135deg, #0E1621 0%, #0E5A44 100%)',
  },
  {
    id: 'amber',
    labelEn: 'Amber Dusk',
    labelZh: '琥珀暮光',
    previewCss: 'linear-gradient(135deg, #141B24 0%, #6E4E1E 100%)',
  },
  {
    id: 'graphite',
    labelEn: 'Graphite Glow',
    labelZh: '石墨星辉',
    previewCss: 'radial-gradient(circle at 50% 35%, #244B6B 0%, #0E1621 80%)',
  },
  {
    id: 'arctic',
    labelEn: 'Arctic Teal',
    labelZh: '极地青蓝',
    previewCss: 'linear-gradient(135deg, #10202E 0%, #1E6B7B 100%)',
  },
  {
    id: 'solid',
    labelEn: 'Pure Matte',
    labelZh: '纯净哑光',
    previewCss: '#0E1621',
  },
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

const PASSKEYS_STORAGE_KEY = 'gpui_tg_registered_passkeys_v1';

interface StoredPasskeyEntry {
  id: string;
  label: string;
  createdAtMs: number;
}

function loadStoredPasskeys(): StoredPasskeyEntry[] {
  try {
    const raw = localStorage.getItem(PASSKEYS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredPasskeyEntry[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore
  }
  return [];
}

export function openShortcutsModalImperatively(): void {
  useUiStore.setState({
    activeModal: 'shortcuts' as unknown as ModalId,
    modalPayload: { source: 'settings' },
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('gpui:open-shortcuts'));
  }
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ className }) => {
  const settingsStack = useUiStore((s) => s.settingsStack);
  const pushSettingsSection = useUiStore((s) => s.pushSettingsSection);
  const popSettingsSection = useUiStore((s) => s.popSettingsSection);
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

  // Auth store
  const currentUser = useAuthStore((s) => s.currentUser);
  const adapterMode = useAuthStore((s) => s.adapterMode);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const serverHealth = useAuthStore((s) => s.serverHealth);
  const mtprotoConfig = useAuthStore((s) => s.mtprotoConfig);
  const passcodeHash = useAuthStore((s) => s.passcodeHash);
  const twoFaStatus = useAuthStore((s) => s.twoFaStatus);
  const activeSessions = useAuthStore((s) => s.activeSessions);

  const setAdapterMode = useAuthStore((s) => s.setAdapterMode);
  const setServerUrl = useAuthStore((s) => s.setServerUrl);
  const probeServerHealth = useAuthStore((s) => s.probeServerHealth);
  const setMtprotoConfig = useAuthStore((s) => s.setMtprotoConfig);
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

  // Chat store
  const activeChatId = useChatStore((s) => s.activeChatId);
  const orderedChatIds = useChatStore((s) => s.orderedChatIds);
  const chatsById = useChatStore((s) => s.chatsById);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
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

  // AI & Wallet store
  const magpieConfig = useAiWorkspaceStore((s) => s.magpieConfig);
  const wallet = useAiWorkspaceStore((s) => s.wallet);
  const pairingTicket = useAiWorkspaceStore((s) => s.pairingTicket);
  const localBridgeState = useAiWorkspaceStore((s) => s.localBridgeState);
  const loadMagpie = useAiWorkspaceStore((s) => s.loadMagpie);
  const loadHermesStudio = useAiWorkspaceStore((s) => s.loadHermesStudio);
  const loadWallet = useAiWorkspaceStore((s) => s.loadWallet);

  const isZh = language === 'zh-CN';
  const isOpen = settingsStack.length > 0;
  const currentSection: SettingsSectionId = settingsStack[settingsStack.length - 1] ?? 'root';

  // Local form states
  const [profileFirstName, setProfileFirstName] = useState('');
  const [profileLastName, setProfileLastName] = useState('');
  const [profileUsername, setProfileUsername] = useState('');
  const [profileBio, setProfileBio] = useState('');
  const [profileAlert, setProfileAlert] = useState<string | null>(null);

  const [timeFormat24h, setTimeFormat24h] = useState(true);
  const [notifSound, setNotifSound] = useState(true);
  const [notifPreview, setNotifPreview] = useState(true);
  const [notifReactions, setNotifReactions] = useState(true);
  const [autoplayGifs, setAutoplayGifs] = useState(true);
  const [autoplayVideos, setAutoplayVideos] = useState(false);

  const [passcodeInput, setPasscodeInput] = useState('');
  const [passcodeStatusMsg, setPasscodeStatusMsg] = useState<string | null>(null);

  const [twoFaCurrentPwd, setTwoFaCurrentPwd] = useState('');
  const [twoFaNewPwd, setTwoFaNewPwd] = useState('');
  const [twoFaHintInput, setTwoFaHintInput] = useState('');
  const [twoFaEmailInput, setTwoFaEmailInput] = useState('');
  const [twoFaAlert, setTwoFaAlert] = useState<string | null>(null);

  const [passkeyLabel, setPasskeyLabel] = useState('GPUI Telegram Web Passkey');
  const [storedPasskeys, setStoredPasskeys] = useState<StoredPasskeyEntry[]>(() =>
    loadStoredPasskeys(),
  );

  const [newFolderTitle, setNewFolderTitle] = useState('');
  const [newFolderEmoji, setNewFolderEmoji] = useState('📁');
  const [editingFolderId, setEditingFolderId] = useState<number | null>(null);
  const [editingFolderTitle, setEditingFolderTitle] = useState('');

  const [exportChatId, setExportChatId] = useState<number | null>(null);
  const [lastExportSummary, setLastExportSummary] = useState<string | null>(null);
  const [cacheClearedAt, setCacheClearedAt] = useState<string | null>(null);

  const [serverUrlDraft, setServerUrlDraft] = useState(serverUrl);
  const [apiIdDraft, setApiIdDraft] = useState(String(mtprotoConfig.apiId));
  const [apiHashDraft, setApiHashDraft] = useState(mtprotoConfig.apiHash);
  const [dcIdDraft, setDcIdDraft] = useState(String(mtprotoConfig.dcId));

  const wpFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!currentUser) return;
    setProfileFirstName(currentUser.firstName ?? '');
    setProfileLastName(currentUser.lastName ?? '');
    setProfileUsername(currentUser.username ?? '');
    setProfileBio(currentUser.bio ?? '');
  }, [currentUser?.userId, currentUser?.firstName, currentUser?.lastName, currentUser?.username, currentUser?.bio]);

  useEffect(() => {
    const defaultId = activeChatId ?? orderedChatIds[0] ?? null;
    setExportChatId(defaultId);
  }, [activeChatId, orderedChatIds]);

  useEffect(() => {
    setServerUrlDraft(serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    if (!isOpen) return;
    if (currentSection === 'privacy' || currentSection === 'blocked_users' || currentSection === 'notifications') {
      void loadPrivacyAndBlocked();
    } else if (currentSection === 'two_fa') {
      void refresh2faStatus().catch(() => undefined);
    } else if (currentSection === 'devices') {
      void loadSessions().catch(() => undefined);
    } else if (currentSection === 'stickers') {
      void loadStickersAndGifs().catch(() => undefined);
    } else if (currentSection === 'magpie_gateway') {
      void loadMagpie().catch(() => undefined);
    } else if (currentSection === 'hermes_studio') {
      void loadHermesStudio().catch(() => undefined);
    } else if (currentSection === 'wallet') {
      void loadWallet().catch(() => undefined);
    }
  }, [
    isOpen,
    currentSection,
    loadPrivacyAndBlocked,
    refresh2faStatus,
    loadSessions,
    loadStickersAndGifs,
    loadMagpie,
    loadHermesStudio,
    loadWallet,
  ]);

  const cachedMessagesCount = useMemo(
    () => Object.values(messagesByChat).reduce((acc, list) => acc + list.length, 0),
    [messagesByChat],
  );

  if (!isOpen) {
    return null;
  }

  const activeMeta = SETTINGS_SECTIONS.find((s) => s.id === currentSection);

  const handleSelectWallpaperPreset = (presetId: string) => {
    setWallpaper(presetId);
    if (presetId === 'arctic' && typeof document !== 'undefined') {
      document.documentElement.style.setProperty(
        '--tg-chat-wallpaper',
        'linear-gradient(135deg, rgba(14, 22, 33, 0.94) 0%, rgba(30, 107, 123, 0.42) 100%)',
      );
    }
  };

  const handleToggleWallpaperBlur = () => {
    const next = !wallpaperBlur;
    setWallpaperBlur(next);
    if (typeof document !== 'undefined') {
      document
        .getElementById(DOM_IDS.MIDDLE_COLUMN)
        ?.setAttribute('data-wallpaper-blur', String(next));
    }
  };

  const handleUploadCustomWallpaper = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (dataUrl && typeof document !== 'undefined') {
        setWallpaper('custom');
        document.documentElement.style.setProperty('--tg-chat-wallpaper', `url("${dataUrl}")`);
        pushToast(isZh ? '自定义壁纸已应用' : 'Custom wallpaper applied', 'success');
      }
    };
    reader.readAsDataURL(file);
  };

  const handleTriggerExport = async (format: 'json' | 'html') => {
    const targetId = exportChatId ?? activeChatId ?? orderedChatIds[0];
    if (!targetId) {
      pushToast(isZh ? '暂无可导出的会话' : 'No chat available to export', 'warning');
      return;
    }
    try {
      const res = await exportChatHistory(targetId, format);
      setLastExportSummary(`${res.fileName} (${res.content.length} bytes)`);
      pushToast(
        isZh ? `已导出 ${res.fileName}` : `Exported ${res.fileName}`,
        'success',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Export failed', 'error');
    }
  };

  const renderExportCard = () => {
    const resolvedTargetId = exportChatId ?? activeChatId ?? orderedChatIds[0] ?? '';
    return (
      <div
        className="tg-surface-card"
        style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px' }}
      >
        <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
          📦 {isZh ? '聊天记录导出 (JSON / HTML)' : 'Chat History Export (JSON / HTML)'}
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
          <span>{isZh ? '选择目标会话' : 'Target Conversation'}</span>
          <select
            className="tg-select"
            aria-label={isZh ? '导出会话选择' : 'Select chat to export'}
            value={resolvedTargetId}
            onChange={(e) => setExportChatId(Number(e.target.value))}
          >
            {orderedChatIds.map((cid) => {
              const c = chatsById[cid];
              if (!c) return null;
              return (
                <option key={cid} value={cid}>
                  {c.title}
                </option>
              );
            })}
          </select>
        </label>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            id={DOM_IDS.BTN_EXPORT_CHAT_JSON}
            type="button"
            className="tg-btn tg-btn--primary"
            style={{ flex: '1 1 auto', fontSize: '12.5px' }}
            onClick={() => void handleTriggerExport('json')}
          >
            ⬇ {t('chatAction.exportJson', language)}
          </button>
          <button
            id={DOM_IDS.BTN_EXPORT_CHAT_HTML}
            type="button"
            className="tg-btn tg-btn--secondary"
            style={{ flex: '1 1 auto', fontSize: '12.5px' }}
            onClick={() => void handleTriggerExport('html')}
          >
            ⬇ {t('chatAction.exportHtml', language)}
          </button>
        </div>

        {lastExportSummary && (
          <div style={{ fontSize: '11.5px', color: 'var(--tg-success)' }}>
            ✓ {lastExportSummary}
          </div>
        )}
      </div>
    );
  };

  const renderWallpaperSectionControls = () => (
    <div
      className="tg-surface-card"
      style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px' }}
    >
      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
        🖼️ {isZh ? '聊天背景壁纸预设' : 'Chat Wallpaper Presets'}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: '8px',
        }}
      >
        {WALLPAPER_PRESETS.map((wp, idx) => {
          const isSelected = wallpaper === wp.id;
          const label = isZh ? wp.labelZh : wp.labelEn;
          return (
            <button
              key={wp.id}
              type="button"
              data-testid={`wallpaper-preset-${idx}`}
              data-wallpaper={wp.id}
              aria-pressed={isSelected}
              aria-label={`Wallpaper ${wp.labelEn}`}
              onClick={() => handleSelectWallpaperPreset(wp.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px',
                padding: '6px',
                borderRadius: '8px',
                border: isSelected ? '2px solid var(--tg-accent)' : '1px solid var(--tg-border)',
                background: 'var(--tg-bg-elevated)',
              }}
            >
              <span
                style={{
                  width: '100%',
                  height: '36px',
                  borderRadius: '5px',
                  background: wp.previewCss,
                  display: 'block',
                }}
              />
              <span style={{ fontSize: '10.5px', color: 'var(--tg-text-secondary)' }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <button
          type="button"
          data-testid="wallpaper-upload-btn"
          aria-label="Upload custom image"
          className="tg-btn tg-btn--secondary"
          style={{ fontSize: '12.5px', padding: '6px 12px' }}
          onClick={() => wpFileInputRef.current?.click()}
        >
          📁 {isZh ? '上传自定义壁纸' : 'Upload Custom Image'}
        </button>
        <input
          ref={wpFileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleUploadCustomWallpaper}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12.5px' }}>
            {isZh ? '毛玻璃模糊' : 'Wallpaper Blur'}
          </span>
          <button
            type="button"
            role="switch"
            data-testid="wallpaper-blur-toggle"
            aria-checked={wallpaperBlur}
            aria-label={isZh ? '壁纸毛玻璃模糊' : 'Wallpaper Blur'}
            className={`tg-switch ${wallpaperBlur ? 'is-checked' : ''}`}
            onClick={handleToggleWallpaperBlur}
          >
            <span className="tg-switch-thumb" />
          </button>
        </div>
      </div>
    </div>
  );

  const handleSaveProfile = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const first = profileFirstName.trim();
    const last = profileLastName.trim();
    const cleanUser = profileUsername.trim().replace(/^@+/, '');

    if (!first) {
      setProfileAlert(isZh ? '名字不能为空' : 'First name is required.');
      return;
    }

    if (
      cleanUser.length > 0 &&
      (cleanUser.length < 5 || cleanUser.length > 32 || !/^[a-zA-Z0-9_]+$/.test(cleanUser))
    ) {
      setProfileAlert(
        isZh
          ? '用户名无效：长度须为 5–32 位，且只能包含字母、数字和下划线'
          : 'Invalid username: must be 5–32 characters containing only letters, digits, or underscores.',
      );
      return;
    }

    try {
      setProfileAlert(null);
      const updated = await updateMyProfile({
        firstName: first,
        lastName: last,
        username: cleanUser || undefined,
        bio: profileBio.trim(),
      });
      useAuthStore.setState({ currentUser: updated });
      pushToast(isZh ? '个人资料已保存' : 'Profile updated successfully', 'success');
    } catch (err) {
      setProfileAlert(err instanceof Error ? err.message : 'Failed to update profile');
    }
  };

  const handleReorderFolder = async (folder: ChatFolder, delta: -1 | 1) => {
    const sorted = [...folders].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex((f) => f.id === folder.id);
    const swapIdx = idx + delta;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
    const neighbor = sorted[swapIdx];
    await upsertFolder({ ...folder, sortOrder: neighbor.sortOrder });
    await upsertFolder({ ...neighbor, sortOrder: folder.sortOrder });
  };

  return (
    <>
      <div
        className="tg-drawer-backdrop"
        aria-hidden="true"
        onClick={closeSettings}
      />

      <aside
        id={DOM_IDS.SETTINGS_PANEL}
        className={className}
        aria-label={t('settings.title', language)}
      >
        {/* Slide-Stack Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            minHeight: '56px',
            padding: '10px 16px',
            borderBottom: '1px solid var(--tg-border)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {currentSection !== 'root' && (
              <button
                type="button"
                className="tg-btn tg-btn--ghost"
                aria-label={isZh ? '返回' : 'Back'}
                style={{ padding: '5px 10px', fontSize: '13.5px' }}
                onClick={popSettingsSection}
              >
                ← {t('common.back', language)}
              </button>
            )}
            <h2
              style={{
                margin: 0,
                fontSize: '16px',
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {currentSection === 'root'
                ? t('settings.title', language)
                : isZh
                  ? activeMeta?.titleZh ?? currentSection
                  : activeMeta?.titleEn ?? currentSection}
            </h2>
          </div>

          <button
            type="button"
            className="tg-icon-btn"
            aria-label={isZh ? '关闭' : 'Close'}
            title={t('common.close', language)}
            onClick={closeSettings}
          >
            ×
          </button>
        </div>

        {/* Scrollable Slide Body */}
        <div className="tg-settings-slide-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* ================================================================
              1. ROOT SECTION — User Summary + Quick Export + 24 Sub-Sections
              ================================================================ */}
          {currentSection === 'root' && (
            <>
              <div
                className="tg-surface-card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px',
                }}
              >
                <div
                  className="tg-avatar tg-avatar--lg"
                  data-color-index={peerAvatarColorIndex(currentUser?.userId ?? 0)}
                >
                  {(currentUser?.firstName ?? 'U').slice(0, 2).toUpperCase()}
                </div>
                <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>
                    {currentUser
                      ? `${currentUser.firstName} ${currentUser.lastName ?? ''}`.trim()
                      : isZh
                        ? '未登录用户'
                        : 'Signed Out'}
                  </div>
                  {currentUser?.username && (
                    <div style={{ fontSize: '12.5px', color: 'var(--tg-accent)' }}>
                      @{currentUser.username}
                    </div>
                  )}
                  {currentUser?.phone && (
                    <div style={{ fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                      {currentUser.phone}
                    </div>
                  )}
                </div>
              </div>

              {/* 24 Navigable Slide-Stack Section Items */}
              <div
                role="list"
                style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
              >
                {SETTINGS_SECTIONS.map((sec) => {
                  const sectionProps: Record<string, string> = {
                    [DATA_ATTRS.SETTINGS_SECTION]: sec.id,
                  };
                  return (
                    <button
                      key={sec.id}
                      type="button"
                      role="button"
                      {...sectionProps}
                      onClick={() => pushSettingsSection(sec.id)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        background: 'var(--tg-bg-elevated)',
                        border: '1px solid var(--tg-border-subtle)',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        <span style={{ fontSize: '18px', flexShrink: 0 }}>{sec.icon}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--tg-text-primary)' }}>
                            {isZh ? sec.titleZh : sec.titleEn}
                          </div>
                          <div
                            style={{
                              fontSize: '11.5px',
                              color: 'var(--tg-text-secondary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {isZh ? sec.subtitleZh : sec.subtitleEn}
                          </div>
                        </div>
                      </div>
                      <span style={{ color: 'var(--tg-text-muted)', fontSize: '14px' }}>›</span>
                    </button>
                  );
                })}
              </div>

              {/* Quick Export & Shortcuts Access on Root */}
              {renderExportCard()}

              <button
                type="button"
                className="tg-btn tg-btn--secondary"
                onClick={openShortcutsModalImperatively}
              >
                ⌨️ {isZh ? '键盘快捷键一览 (?)' : 'Keyboard Shortcuts (?)'}
              </button>
            </>
          )}

          {/* ================================================================
              2. EDIT PROFILE (Strict @username Validation)
              ================================================================ */}
          {currentSection === 'edit_profile' && (
            <form
              onSubmit={handleSaveProfile}
              className="tg-surface-card"
              style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              {profileAlert && (
                <div
                  role="alert"
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    background: 'var(--tg-danger-soft)',
                    color: 'var(--tg-danger)',
                    fontSize: '12.5px',
                  }}
                >
                  {profileAlert}
                </div>
              )}

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                <span>{t('auth.password.firstName', language)} *</span>
                <input
                  type="text"
                  className="tg-input"
                  value={profileFirstName}
                  onChange={(e) => setProfileFirstName(e.target.value)}
                  aria-label="First Name"
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                <span>{t('auth.password.lastName', language)}</span>
                <input
                  type="text"
                  className="tg-input"
                  value={profileLastName}
                  onChange={(e) => setProfileLastName(e.target.value)}
                  aria-label="Last Name"
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                <span>@Username (5–32 letters, digits, underscores)</span>
                <input
                  type="text"
                  className="tg-input"
                  value={profileUsername}
                  onChange={(e) => setProfileUsername(e.target.value)}
                  placeholder="username_handle"
                  aria-label="Username"
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                <span>{isZh ? '个人简介 (Bio)' : 'Bio'}</span>
                <textarea
                  className="tg-textarea"
                  rows={3}
                  value={profileBio}
                  onChange={(e) => setProfileBio(e.target.value)}
                  aria-label="Bio"
                  placeholder={isZh ? '介绍一下你自己…' : 'A few words about yourself…'}
                />
              </label>

              <button type="submit" className="tg-btn tg-btn--primary">
                {t('common.save', language)}
              </button>
            </form>
          )}

          {/* ================================================================
              3. GENERAL SETTINGS
              ================================================================ */}
          {currentSection === 'general' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                {isZh ? '键盘发送方式' : 'Keyboard Send Behavior'}
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="sendByEnterMode"
                  checked={sendByEnter}
                  onChange={() => setSendByEnter(true)}
                />
                <span>{isZh ? '按 Enter 发送消息 (Shift+Enter 换行)' : 'Send with Enter (Shift+Enter for new line)'}</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="sendByEnterMode"
                  checked={!sendByEnter}
                  onChange={() => setSendByEnter(false)}
                />
                <span>{isZh ? '按 Ctrl+Enter 发送消息' : 'Send with Ctrl+Enter'}</span>
              </label>

              <hr style={{ border: 'none', borderTop: '1px solid var(--tg-border)', width: '100%' }} />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '13.5px' }}>
                  {isZh ? '显示自动翻译栏 (Auto-Translate)' : 'Show Auto-Translate Bar'}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoTranslate}
                  className={`tg-switch ${autoTranslate ? 'is-checked' : ''}`}
                  onClick={() => setAutoTranslate(!autoTranslate)}
                >
                  <span className="tg-switch-thumb" />
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '13.5px' }}>
                  {isZh ? '24 小时制时间格式' : '24-Hour Time Format'}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={timeFormat24h}
                  className={`tg-switch ${timeFormat24h ? 'is-checked' : ''}`}
                  onClick={() => setTimeFormat24h((v) => !v)}
                >
                  <span className="tg-switch-thumb" />
                </button>
              </div>
            </div>
          )}

          {/* ================================================================
              4. APPEARANCE & THEMES (4 Themes + 8 Non-Purple Swatches + Wallpapers + 3 Sliders)
              ================================================================ */}
          {currentSection === 'appearance' && (
            <>
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                  {isZh ? '色彩主题模式' : 'Color Theme Mode'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' }}>
                  {(
                    [
                      { id: 'night', label: t('settings.theme.night', language), bg: '#0E1621', fg: '#F5F5F5' },
                      { id: 'tinted', label: t('settings.theme.tinted', language), bg: '#101B29', fg: '#F5F8FC' },
                      { id: 'day', label: t('settings.theme.day', language), bg: '#F4F4F5', fg: '#11161C' },
                      { id: 'classic', label: t('settings.theme.classic', language), bg: '#E6EBEE', fg: '#1C242B' },
                    ] as Array<{ id: ThemeName; label: string; bg: string; fg: string }>
                  ).map((item) => {
                    const active = theme === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-theme-option={item.id}
                        data-testid={`theme-card-${item.id}`}
                        aria-pressed={active}
                        onClick={() => setTheme(item.id)}
                        style={{
                          padding: '10px 12px',
                          borderRadius: '10px',
                          border: active ? '2px solid var(--tg-accent)' : '1px solid var(--tg-border)',
                          background: item.bg,
                          color: item.fg,
                          fontWeight: 600,
                          fontSize: '13px',
                          textAlign: 'left',
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>

                {/* 8 Strictly Non-Purple Accent Swatches */}
                <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '4px' }}>
                  {isZh ? '强调色 (零紫色规范)' : 'Accent Color'}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {NON_PURPLE_ACCENT_SWATCHES.map((hex, idx) => {
                    const selected = accentColor.toUpperCase() === hex.toUpperCase();
                    return (
                      <button
                        key={hex}
                        type="button"
                        data-testid={`accent-swatch-${idx}`}
                        data-accent-swatch={hex}
                        aria-label={`Accent color ${hex}`}
                        aria-pressed={selected}
                        onClick={() => setAccentColor(hex)}
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          backgroundColor: hex,
                          border: selected ? '3px solid var(--tg-text-primary)' : '2px solid transparent',
                          color: '#FFFFFF',
                          fontSize: '13px',
                          fontWeight: 700,
                        }}
                      >
                        {selected ? '✓' : ''}
                      </button>
                    );
                  })}
                </div>
              </div>

              {renderWallpaperSectionControls()}

              {/* Typography, Bubble Radius & UI Scale Sliders */}
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t('settings.fontSize', language)}</span>
                    <strong>{fontSize}px</strong>
                  </div>
                  <input
                    type="range"
                    className="tg-slider"
                    name="fontSize"
                    min={12}
                    max={20}
                    step={1}
                    value={fontSize}
                    aria-label="Message Font Size"
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t('settings.bubbleRadius', language)}</span>
                    <strong>{bubbleRadius}px</strong>
                  </div>
                  <input
                    type="range"
                    className="tg-slider"
                    name="bubbleRadius"
                    min={6}
                    max={18}
                    step={1}
                    value={bubbleRadius}
                    aria-label="Bubble Corner Radius"
                    onChange={(e) => setBubbleRadius(Number(e.target.value))}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t('settings.uiScale', language)}</span>
                    <strong>{uiScale}%</strong>
                  </div>
                  <input
                    type="range"
                    className="tg-slider"
                    name="uiScale"
                    min={50}
                    max={200}
                    step={5}
                    value={uiScale}
                    aria-label="Interface Scale"
                    onChange={(e) => setUiScale(Number(e.target.value))}
                  />
                </label>

                <button
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  onClick={resetAppearance}
                >
                  ↺ {isZh ? '恢复默认外观' : 'Reset Appearance'}
                </button>
              </div>
            </>
          )}

          {/* ================================================================
              5. WALLPAPER SUB-PAGE
              ================================================================ */}
          {currentSection === 'wallpaper' && renderWallpaperSectionControls()}

          {/* ================================================================
              6. NOTIFICATIONS & SOUNDS
              ================================================================ */}
          {currentSection === 'notifications' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {[
                {
                  label: isZh ? '开启桌面消息通知' : 'Desktop Notifications',
                  checked: notificationsEnabled,
                  toggle: () => setNotificationsEnabled(!notificationsEnabled),
                },
                {
                  label: isZh ? '播放通知提示音' : 'Notification Sounds',
                  checked: notifSound,
                  toggle: () => {
                    const next = !notifSound;
                    setNotifSound(next);
                    void updatePrivacy({ notifications_sound: next });
                  },
                },
                {
                  label: isZh ? '显示消息内容预览' : 'Message Text Preview',
                  checked: notifPreview,
                  toggle: () => setNotifPreview((v) => !v),
                },
                {
                  label: isZh ? '表情回应通知' : 'Reaction Notifications',
                  checked: notifReactions,
                  toggle: () => setNotifReactions((v) => !v),
                },
              ].map((row) => (
                <div
                  key={row.label}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}
                >
                  <span style={{ fontSize: '13.5px' }}>{row.label}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={row.checked}
                    className={`tg-switch ${row.checked ? 'is-checked' : ''}`}
                    onClick={row.toggle}
                  >
                    <span className="tg-switch-thumb" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ================================================================
              7. PRIVACY & SECURITY
              ================================================================ */}
          {currentSection === 'privacy' && (
            <>
              {/* Quick Security Sub-Destinations */}
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--tg-text-secondary)' }}>
                  {isZh ? '账号安全保护' : 'Account Security'}
                </div>
                <button
                  type="button"
                  data-testid="privacy-goto-passcode"
                  className="tg-btn tg-btn--secondary"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => pushSettingsSection('passcode')}
                >
                  <span>🔐 {isZh ? '本地密码锁 (Passcode Lock)' : 'Local Passcode Lock'}</span>
                  <span>{passcodeHash ? 'ON' : 'OFF'} ›</span>
                </button>
                <button
                  type="button"
                  data-testid="privacy-goto-2fa"
                  className="tg-btn tg-btn--secondary"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => pushSettingsSection('two_fa')}
                >
                  <span>🔑 {isZh ? '两步验证云密码 (Two-Step Verification 2FA)' : 'Two-Step Verification (2FA)'}</span>
                  <span>{twoFaStatus?.enabled ? 'ON' : 'OFF'} ›</span>
                </button>
                <button
                  type="button"
                  data-testid="privacy-goto-passkeys"
                  className="tg-btn tg-btn--secondary"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => pushSettingsSection('passkeys')}
                >
                  <span>🪪 {isZh ? '通行密钥 (Passkeys / WebAuthn)' : 'Passkeys (WebAuthn)'}</span>
                  <span>{storedPasskeys.length} ›</span>
                </button>
                <button
                  type="button"
                  data-testid="privacy-goto-blocked"
                  className="tg-btn tg-btn--secondary"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => pushSettingsSection('blocked_users')}
                >
                  <span>🚫 {isZh ? '黑名单管理 (Blocked Users)' : 'Blocked Users'}</span>
                  <span>{blockedUsers.length} ›</span>
                </button>
              </div>

              {/* Visibility Rules */}
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                  {isZh ? '可见性与权限范围' : 'Who Can See My Info'}
                </div>

                {(
                  [
                    { key: 'last_seen_privacy', labelEn: 'Last Seen & Online', labelZh: '最后上线时间' },
                    { key: 'photo_privacy', labelEn: 'Profile Photos', labelZh: '个人头像' },
                    { key: 'calls_privacy', labelEn: 'Voice & Video Calls', labelZh: '语音与视频通话' },
                    { key: 'forwards_privacy', labelEn: 'Forwarded Messages', labelZh: '转发消息来源链接' },
                    { key: 'groups_privacy', labelEn: 'Groups & Channels Invite', labelZh: '拉我进群组/频道' },
                  ] as const
                ).map((item) => {
                  const currentVal = privacySettings?.[item.key] ?? 'everybody';
                  return (
                    <label
                      key={item.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        fontSize: '13px',
                      }}
                    >
                      <span>{isZh ? item.labelZh : item.labelEn}</span>
                      <select
                        className="tg-select"
                        style={{ width: '148px', padding: '5px 8px' }}
                        value={currentVal}
                        onChange={(e) =>
                          void updatePrivacy({ [item.key]: e.target.value })
                        }
                      >
                        {PRIVACY_LEVELS.map((lvl) => (
                          <option key={lvl.value} value={lvl.value}>
                            {isZh ? lvl.labelZh : lvl.labelEn}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {/* ================================================================
              8. LOCAL PASSCODE LOCK
              ================================================================ */}
          {currentSection === 'passcode' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)' }}>
                {t('passcode.shortcutHint', language)}
              </div>

              {passcodeStatusMsg && (
                <div style={{ fontSize: '12.5px', color: 'var(--tg-success)' }}>
                  {passcodeStatusMsg}
                </div>
              )}

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <span>{isZh ? '设置或修改本地密码锁 (PIN)' : 'Local Passcode / PIN'}</span>
                <input
                  type="password"
                  name="passcode"
                  className="tg-input"
                  value={passcodeInput}
                  onChange={(e) => setPasscodeInput(e.target.value)}
                  placeholder={isZh ? '输入 4 位以上本地密码锁' : 'Enter 4+ digit PIN or passcode'}
                  aria-label="Local Passcode"
                />
              </label>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="tg-btn tg-btn--primary"
                  onClick={async () => {
                    if (!passcodeInput.trim()) return;
                    await setPasscode(passcodeInput.trim());
                    setPasscodeInput('');
                    setPasscodeStatusMsg(isZh ? '本地密码锁已启用' : 'Local passcode enabled');
                    pushToast(isZh ? '本地密码锁已启用' : 'Local passcode enabled', 'success');
                  }}
                >
                  {t('passcode.enable', language)}
                </button>

                {passcodeHash && (
                  <>
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      onClick={() => {
                        closeSettings();
                        lockApp();
                      }}
                    >
                      🔒 {isZh ? '立即锁定 (Ctrl+Shift+L)' : 'Lock Now (Ctrl+Shift+L)'}
                    </button>
                    <button
                      type="button"
                      className="tg-btn tg-btn--danger-soft"
                      onClick={async () => {
                        const ok = await clearPasscode(passcodeInput.trim() || undefined);
                        if (ok) {
                          setPasscodeInput('');
                          setPasscodeStatusMsg(isZh ? '本地密码锁已关闭' : 'Local passcode disabled');
                        }
                      }}
                    >
                      {t('passcode.disable', language)}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ================================================================
              9. CLOUD 2FA PASSWORD
              ================================================================ */}
          {currentSection === 'two_fa' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '13.5px', fontWeight: 600 }}>
                  {t('auth.twoFa.title', language)}
                </span>
                <span className={`tg-badge ${twoFaStatus?.enabled ? '' : 'tg-badge--muted'}`}>
                  {twoFaStatus?.enabled ? (isZh ? '已开启' : 'Enabled') : isZh ? '未开启' : 'Disabled'}
                </span>
              </div>

              {twoFaAlert && (
                <div
                  role="alert"
                  style={{
                    padding: '7px 10px',
                    borderRadius: '6px',
                    background: 'var(--tg-danger-soft)',
                    color: 'var(--tg-danger)',
                    fontSize: '12px',
                  }}
                >
                  {twoFaAlert}
                </div>
              )}

              {twoFaStatus?.enabled ? (
                <>
                  <input
                    type="password"
                    className="tg-input"
                    value={twoFaCurrentPwd}
                    onChange={(e) => setTwoFaCurrentPwd(e.target.value)}
                    placeholder={isZh ? '当前两步验证云密码' : 'Current Cloud 2FA Password'}
                    aria-label="Current 2FA Password"
                  />
                  <button
                    type="button"
                    className="tg-btn tg-btn--danger"
                    onClick={async () => {
                      try {
                        setTwoFaAlert(null);
                        await disable2faPassword(twoFaCurrentPwd || undefined);
                        setTwoFaCurrentPwd('');
                        pushToast(isZh ? '两步验证已关闭' : 'Cloud 2FA disabled', 'info');
                      } catch (err) {
                        setTwoFaAlert(err instanceof Error ? err.message : 'Failed to disable 2FA');
                      }
                    }}
                  >
                    {isZh ? '关闭两步验证' : 'Disable Two-Step Verification'}
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="password"
                    className="tg-input"
                    value={twoFaNewPwd}
                    onChange={(e) => setTwoFaNewPwd(e.target.value)}
                    placeholder={isZh ? '设置新两步验证云密码' : 'New Cloud 2FA Password'}
                    aria-label="New Cloud 2FA Password"
                  />
                  <input
                    type="text"
                    className="tg-input"
                    value={twoFaHintInput}
                    onChange={(e) => setTwoFaHintInput(e.target.value)}
                    placeholder={isZh ? '密码提示 (可选)' : 'Password Hint (optional)'}
                    aria-label="2FA Password Hint"
                  />
                  <input
                    type="email"
                    className="tg-input"
                    value={twoFaEmailInput}
                    onChange={(e) => setTwoFaEmailInput(e.target.value)}
                    placeholder={isZh ? '恢复邮箱 (可选)' : 'Recovery Email (optional)'}
                    aria-label="Recovery Email"
                  />
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={async () => {
                      if (!twoFaNewPwd.trim()) {
                        setTwoFaAlert(isZh ? '请输入云密码' : 'Please enter a cloud password');
                        return;
                      }
                      try {
                        setTwoFaAlert(null);
                        await set2faPassword({
                          newPassword: twoFaNewPwd,
                          hint: twoFaHintInput.trim() || undefined,
                          recoveryEmail: twoFaEmailInput.trim() || undefined,
                        });
                        setTwoFaNewPwd('');
                        pushToast(isZh ? '两步验证云密码已启用' : 'Cloud 2FA enabled', 'success');
                      } catch (err) {
                        setTwoFaAlert(err instanceof Error ? err.message : 'Failed to enable 2FA');
                      }
                    }}
                  >
                    {isZh ? '开启两步验证' : 'Enable Cloud 2FA Password'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ================================================================
              10. PASSKEYS (WebAuthn)
              ================================================================ */}
          {currentSection === 'passkeys' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)' }}>
                {isZh
                  ? '使用设备生物识别或安全密钥 (FIDO2 / WebAuthn) 实现免密安全登录。'
                  : 'Sign in securely without passwords using biometric sensors or FIDO2 hardware keys.'}
              </div>

              <input
                type="text"
                className="tg-input"
                value={passkeyLabel}
                onChange={(e) => setPasskeyLabel(e.target.value)}
                aria-label="Passkey Label"
                placeholder="Passkey device label"
              />

              <button
                type="button"
                data-testid="btn-register-passkey"
                className="tg-btn tg-btn--primary"
                onClick={async () => {
                  const ok = await registerPasskey(passkeyLabel.trim() || 'Telegram Web Passkey');
                  if (ok) {
                    const entry: StoredPasskeyEntry = {
                      id: `pk_${Date.now()}`,
                      label: passkeyLabel.trim() || 'Telegram Web Passkey',
                      createdAtMs: Date.now(),
                    };
                    const next = [entry, ...storedPasskeys];
                    setStoredPasskeys(next);
                    try {
                      localStorage.setItem(PASSKEYS_STORAGE_KEY, JSON.stringify(next));
                    } catch {
                      // Ignore
                    }
                    pushToast(isZh ? '通行密钥注册成功' : 'Passkey registered', 'success');
                  } else {
                    pushToast(
                      isZh ? '当前环境取消或不支持通行密钥注册' : 'Passkey registration cancelled',
                      'warning',
                    );
                  }
                }}
              >
                🪪 {t('auth.passkey.register', language)}
              </button>

              {storedPasskeys.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                  {storedPasskeys.map((pk) => (
                    <div
                      key={pk.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '8px 10px',
                        borderRadius: '8px',
                        background: 'var(--tg-bg-elevated)',
                        fontSize: '12.5px',
                      }}
                    >
                      <span>🔑 {pk.label}</span>
                      <span style={{ color: 'var(--tg-text-secondary)' }}>
                        {new Date(pk.createdAtMs).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ================================================================
              11. BLOCKED USERS
              ================================================================ */}
          {currentSection === 'blocked_users' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {blockedUsers.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)', textAlign: 'center', padding: '18px 0' }}>
                  {isZh ? '黑名单为空' : 'No blocked users.'}
                </div>
              ) : (
                blockedUsers.map((u) => (
                  <div
                    key={u.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: 'var(--tg-bg-elevated)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                        {u.firstName} {u.lastName ?? ''}
                      </div>
                      {u.username && (
                        <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                          @{u.username}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      style={{ padding: '4px 10px', fontSize: '12px' }}
                      onClick={() => void toggleBlockUser(u.userId, false)}
                    >
                      {t('inspector.unblockUser', language)}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ================================================================
              12. GLOBAL AUTO-DELETE TIMER
              ================================================================ */}
          {currentSection === 'auto_delete' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)' }}>
                {isZh
                  ? '为所有新开启的对话自动设置消息定期销毁计时器。'
                  : 'Automatically delete new messages in newly started chats after the selected period.'}
              </div>
              {GLOBAL_TTL_OPTIONS.map((opt) => (
                <label
                  key={opt.seconds}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 10px',
                    borderRadius: '8px',
                    background: 'var(--tg-bg-elevated)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="globalAutoDelete"
                    checked={globalTtl === opt.seconds}
                    onChange={() => {
                      setGlobalTtl(opt.seconds);
                      void updatePrivacy({ global_ttl_seconds: opt.seconds });
                    }}
                  />
                  <span style={{ fontSize: '13.5px' }}>{isZh ? opt.labelZh : opt.labelEn}</span>
                </label>
              ))}
            </div>
          )}

          {/* ================================================================
              13. CHAT FOLDERS (Create, Edit, Reorder, Delete)
              ================================================================ */}
          {currentSection === 'folders' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newFolderTitle.trim()) return;
                  await upsertFolder({
                    title: newFolderTitle.trim(),
                    emoticon: newFolderEmoji || '📁',
                    includeContacts: true,
                    includeGroups: true,
                    includeChannels: true,
                  });
                  setNewFolderTitle('');
                }}
                className="tg-surface-card"
                style={{ display: 'flex', gap: '8px' }}
              >
                <input
                  type="text"
                  className="tg-input"
                  style={{ width: '52px', textAlign: 'center' }}
                  value={newFolderEmoji}
                  onChange={(e) => setNewFolderEmoji(e.target.value)}
                  aria-label="Folder Icon"
                />
                <input
                  type="text"
                  className="tg-input"
                  value={newFolderTitle}
                  onChange={(e) => setNewFolderTitle(e.target.value)}
                  placeholder={isZh ? '新建分组名称…' : 'New folder name…'}
                  aria-label="New Folder Title"
                />
                <button type="submit" className="tg-btn tg-btn--primary" style={{ flexShrink: 0 }}>
                  {t('common.create', language)}
                </button>
              </form>

              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {folders.length === 0 ? (
                  <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)', textAlign: 'center', padding: '12px' }}>
                    {isZh ? '暂无自定义分组' : 'No custom folders created yet.'}
                  </div>
                ) : (
                  [...folders]
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((folder) => (
                      <div
                        key={folder.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: 'var(--tg-bg-elevated)',
                        }}
                      >
                        {editingFolderId === folder.id ? (
                          <input
                            type="text"
                            className="tg-input"
                            style={{ padding: '4px 8px' }}
                            value={editingFolderTitle}
                            onChange={(e) => setEditingFolderTitle(e.target.value)}
                          />
                        ) : (
                          <span style={{ fontSize: '13.5px', fontWeight: 600 }}>
                            {folder.emoticon ?? '📁'} {folder.title}
                          </span>
                        )}

                        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                          <button
                            type="button"
                            className="tg-btn tg-btn--secondary"
                            style={{ padding: '3px 7px', fontSize: '11.5px' }}
                            aria-label="Move folder up"
                            onClick={() => void handleReorderFolder(folder, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="tg-btn tg-btn--secondary"
                            style={{ padding: '3px 7px', fontSize: '11.5px' }}
                            aria-label="Move folder down"
                            onClick={() => void handleReorderFolder(folder, 1)}
                          >
                            ↓
                          </button>
                          {editingFolderId === folder.id ? (
                            <button
                              type="button"
                              className="tg-btn tg-btn--primary"
                              style={{ padding: '3px 8px', fontSize: '11.5px' }}
                              onClick={async () => {
                                if (editingFolderTitle.trim()) {
                                  await upsertFolder({ ...folder, title: editingFolderTitle.trim() });
                                }
                                setEditingFolderId(null);
                              }}
                            >
                              {t('common.save', language)}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="tg-btn tg-btn--secondary"
                              style={{ padding: '3px 8px', fontSize: '11.5px' }}
                              onClick={() => {
                                setEditingFolderId(folder.id);
                                setEditingFolderTitle(folder.title);
                              }}
                            >
                              {t('message.edit', language)}
                            </button>
                          )}
                          <button
                            type="button"
                            className="tg-btn tg-btn--danger-soft"
                            style={{ padding: '3px 8px', fontSize: '11.5px' }}
                            onClick={() => void deleteFolder(folder.id)}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          )}

          {/* ================================================================
              14. DEVICES & ACTIVE SESSIONS
              ================================================================ */}
          {currentSection === 'devices' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <button
                type="button"
                className="tg-btn tg-btn--danger-soft"
                onClick={async () => {
                  const count = await revokeOtherSessions();
                  pushToast(
                    isZh ? `已终止 ${count} 个其他设备会话` : `Terminated ${count} other sessions`,
                    'info',
                  );
                }}
              >
                🚫 {t('settings.terminateOtherSessions', language)}
              </button>

              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {activeSessions.length === 0 ? (
                  <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)' }}>
                    💻 GPUI Telegram Web (Current Browser Session)
                  </div>
                ) : (
                  activeSessions.map((sess) => (
                    <div
                      key={sess.session_id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '10px',
                        borderRadius: '8px',
                        background: 'var(--tg-bg-elevated)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                          {sess.device_name || 'Web Client'}
                          {sess.is_current && (
                            <span className="tg-badge" style={{ marginLeft: '6px', fontSize: '10px' }}>
                              Current
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                          {sess.platform ?? 'Browser'} · {sess.ip_address ?? '127.0.0.1'}
                        </div>
                      </div>
                      {!sess.is_current && (
                        <button
                          type="button"
                          className="tg-btn tg-btn--danger-soft"
                          style={{ padding: '4px 10px', fontSize: '12px' }}
                          onClick={() => void revokeSession(sess.session_id)}
                        >
                          {isZh ? '注销' : 'Terminate'}
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ================================================================
              15. DATA & STORAGE
              ================================================================ */}
          {currentSection === 'data_storage' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                  💾 {isZh ? 'IndexedDB 本地离线缓存' : 'IndexedDB Local Cache'}
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                  {isZh
                    ? `已缓存 ${orderedChatIds.length} 个会话 · ${cachedMessagesCount} 条消息`
                    : `Cached ${orderedChatIds.length} chats · ${cachedMessagesCount} messages`}
                </div>
                <button
                  type="button"
                  className="tg-btn tg-btn--danger-soft"
                  onClick={async () => {
                    await indexedDbCache.clearAll();
                    setCacheClearedAt(new Date().toLocaleTimeString());
                    pushToast(isZh ? '本地缓存已清空' : 'Local IndexedDB cache cleared', 'success');
                  }}
                >
                  🗑️ {isZh ? '清空本地缓存 (Clear Local Cache)' : 'Clear Local Cache'}
                </button>
                {cacheClearedAt && (
                  <div style={{ fontSize: '11.5px', color: 'var(--tg-success)' }}>
                    ✓ Cleared at {cacheClearedAt}
                  </div>
                )}
              </div>

              {renderExportCard()}
            </div>
          )}

          {/* ================================================================
              16. LANGUAGE
              ================================================================ */}
          {currentSection === 'language' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {(
                [
                  { code: 'en-US', title: 'English (en-US)', native: 'English' },
                  { code: 'zh-CN', title: '简体中文 (zh-CN)', native: 'Simplified Chinese' },
                ] as Array<{ code: LocaleCode; title: string; native: string }>
              ).map((lang) => (
                <label
                  key={lang.code}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'var(--tg-bg-elevated)',
                    cursor: 'pointer',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>{lang.title}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>{lang.native}</div>
                  </div>
                  <input
                    type="radio"
                    name="appLocaleRadio"
                    checked={language === lang.code}
                    onChange={() => setLanguage(lang.code)}
                  />
                </label>
              ))}
            </div>
          )}

          {/* ================================================================
              17. STICKERS & EMOJI
              ================================================================ */}
          {currentSection === 'stickers' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {stickerSets.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--tg-text-secondary)' }}>
                  😊 {isZh ? '默认矢量表情贴纸包已内置激活' : 'Built-in vector sticker packs active'}
                </div>
              ) : (
                stickerSets.map((pack) => (
                  <div
                    key={pack.set_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: 'var(--tg-bg-elevated)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{pack.title}</div>
                      <div style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
                        {pack.count} stickers
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`tg-btn ${pack.is_installed ? 'tg-btn--secondary' : 'tg-btn--primary'}`}
                      style={{ padding: '4px 10px', fontSize: '12px' }}
                      onClick={() => void installStickerSet(pack.set_id, !pack.is_installed)}
                    >
                      {pack.is_installed ? (isZh ? '移除' : 'Remove') : isZh ? '安装' : 'Add'}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ================================================================
              18. POWER SAVING
              ================================================================ */}
          {currentSection === 'power_saving' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '13.5px' }}>
                  {isZh ? '启用省电模式 (减少界面过渡动画)' : 'Reduce Animations & Transitions'}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={powerSaving}
                  className={`tg-switch ${powerSaving ? 'is-checked' : ''}`}
                  onClick={() => setPowerSaving(!powerSaving)}
                >
                  <span className="tg-switch-thumb" />
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '13.5px' }}>
                  {isZh ? '自动播放 GIF 动图' : 'Autoplay GIFs'}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoplayGifs}
                  className={`tg-switch ${autoplayGifs ? 'is-checked' : ''}`}
                  onClick={() => setAutoplayGifs((v) => !v)}
                >
                  <span className="tg-switch-thumb" />
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '13.5px' }}>
                  {isZh ? '静音自动播放视频' : 'Autoplay Videos Muted'}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoplayVideos}
                  className={`tg-switch ${autoplayVideos ? 'is-checked' : ''}`}
                  onClick={() => setAutoplayVideos((v) => !v)}
                >
                  <span className="tg-switch-thumb" />
                </button>
              </div>
            </div>
          )}

          {/* ================================================================
              19. CHAT EXPORT
              ================================================================ */}
          {currentSection === 'chat_export' && renderExportCard()}

          {/* ================================================================
              20. CONNECTION MODE & SERVER CONFIGURATION
              ================================================================ */}
          {currentSection === 'connection_mode' && (() => {
            const demoAllowed = isDemoUiEnabled(adapterMode);
            return (
              <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                    {isZh ? '后端服务器连接配置' : 'Backend Server Connection'}
                  </div>
                  <span
                    style={{
                      fontSize: '11.5px',
                      padding: '2px 8px',
                      borderRadius: '999px',
                      backgroundColor: serverHealth?.ok ? 'var(--tg-success-soft)' : 'var(--tg-warning-soft)',
                      color: serverHealth?.ok ? 'var(--tg-success)' : 'var(--tg-warning)',
                      fontWeight: 600,
                    }}
                  >
                    {serverHealth?.ok
                      ? `● ${isZh ? '已连接' : 'Online'} (${serverHealth.version ?? 'v1.3.0'}${serverHealth.mode ? ` · ${serverHealth.mode}` : ''})`
                      : isZh
                        ? '○ 未检测 / 离线'
                        : '○ Unchecked / Offline'}
                  </span>
                </div>

                {demoAllowed && (
                  <>
                    {(
                      [
                        { mode: 'server', label: t('auth.adapter.server', language) },
                        { mode: 'sandbox', label: t('auth.adapter.sandbox', language) },
                        { mode: 'mtproto', label: t('auth.adapter.mtproto', language) },
                      ] as Array<{ mode: AdapterMode; label: string }>
                    ).map((item) => (
                      <label
                        key={item.mode}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '8px 10px',
                          borderRadius: '8px',
                          background: 'var(--tg-bg-elevated)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="adapterTransportMode"
                          checked={adapterMode === item.mode}
                          onChange={() => void setAdapterMode(item.mode)}
                        />
                        <span style={{ fontSize: '13px' }}>{item.label}</span>
                      </label>
                    ))}
                  </>
                )}

                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
                  <span>{t('auth.adapter.serverUrl', language)}</span>
                  <input
                    type="text"
                    className="tg-input"
                    placeholder="留空使用当前域名，或填写 https://web.ombhrum.com"
                    value={serverUrlDraft}
                    onChange={(e) => setServerUrlDraft(e.target.value)}
                  />
                </label>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {[
                    { label: isZh ? '当前域名' : 'Same Origin', url: '' },
                    { label: 'web.ombhrum.com', url: 'https://web.ombhrum.com' },
                    { label: isZh ? '桌面同源后端' : 'Desktop Cloud', url: 'http://34.46.77.133:8080' },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="tg-btn tg-btn--secondary"
                      style={{ padding: '4px 9px', fontSize: '11.5px' }}
                      onClick={() => setServerUrlDraft(preset.url)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                {demoAllowed && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                        <span>MTProto API ID</span>
                        <input
                          type="text"
                          className="tg-input"
                          value={apiIdDraft}
                          onChange={(e) => setApiIdDraft(e.target.value)}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                        <span>DC ID</span>
                        <input
                          type="text"
                          className="tg-input"
                          value={dcIdDraft}
                          onChange={(e) => setDcIdDraft(e.target.value)}
                        />
                      </label>
                    </div>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                      <span>MTProto API Hash</span>
                      <input
                        type="text"
                        className="tg-input"
                        value={apiHashDraft}
                        onChange={(e) => setApiHashDraft(e.target.value)}
                      />
                    </label>
                  </>
                )}

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="tg-btn tg-btn--primary"
                    onClick={async () => {
                      setServerUrl(serverUrlDraft.trim());
                      if (demoAllowed) {
                        setMtprotoConfig({
                          apiId: Number(apiIdDraft) || 2040,
                          apiHash: apiHashDraft.trim(),
                          dcId: Number(dcIdDraft) || 2,
                        });
                      }
                      const snap = await probeServerHealth();
                      pushToast(
                        snap.ok
                          ? isZh
                            ? `已连接至服务器 (${snap.version ?? 'v1.3.0'})`
                            : `Connected (${snap.version ?? 'v1.3.0'})`
                          : isZh
                            ? `配置已保存，但服务器连通性检测失败：${snap.error ?? '不可达'}`
                            : `Saved, server probe failed: ${snap.error ?? 'unreachable'}`,
                        snap.ok ? 'success' : 'warning',
                      );
                    }}
                  >
                    {isZh ? '保存并检测连通性' : 'Save & Test Connection'}
                  </button>
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    onClick={async () => {
                      const snap = await probeServerHealth();
                      pushToast(
                        snap.ok
                          ? isZh
                            ? `服务器在线 (${snap.version ?? 'v1.3.0'})`
                            : `Server online (${snap.version ?? 'v1.3.0'})`
                          : isZh
                            ? `服务器不可达：${snap.error ?? '请检查地址或网络'}`
                            : `Server unreachable: ${snap.error ?? 'network error'}`,
                        snap.ok ? 'success' : 'error',
                      );
                    }}
                  >
                    {isZh ? '检测连通性' : 'Probe Health'}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ================================================================
              21. MAGPIE LLM GATEWAY
              ================================================================ */}
          {currentSection === 'magpie_gateway' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                🐦 {t('magpie.title', language)}
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                {magpieConfig?.activeProvider
                  ? `${isZh ? '当前默认模型' : 'Active Model'}: ${magpieConfig.activeProvider}${magpieConfig.activeModel ? ` (${magpieConfig.activeModel})` : ''}`
                  : isZh
                    ? '尚未配置外部 LLM 模型供应商'
                    : 'No external LLM provider configured yet'}
                {' · '}PII Masking:{' '}
                <strong>{magpieConfig?.masking?.enabled ? 'Active' : 'Off'}</strong>
              </div>
              <button
                type="button"
                className="tg-btn tg-btn--primary"
                onClick={() => {
                  closeSettings();
                  setActiveNavDest('hermes');
                  if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('gpui:open-magpie-gateway'));
                  }
                }}
              >
                🐦 {isZh ? '打开 Magpie 模型网关面板' : 'Open Magpie Gateway Panel'}
              </button>
            </div>
          )}

          {/* ================================================================
              22. HERMES 6-TAB STUDIO
              ================================================================ */}
          {currentSection === 'hermes_studio' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                🤖 {t('hermes.title', language)}
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                {isZh
                  ? '集中管理智能体会话、长短期记忆、技能中心、沙盒终端、Cron 任务与审批看板。'
                  : 'Unified 6-tab workspace for AI sessions, memory, skills, terminal tools, cron jobs, and approvals.'}
              </div>
              <button
                type="button"
                className="tg-btn tg-btn--primary"
                onClick={() => {
                  closeSettings();
                  setActiveNavDest('hermes');
                }}
              >
                🤖 {isZh ? '进入 Hermes 智能工作台' : 'Open Hermes AI Studio'}
              </button>
            </div>
          )}

          {/* ================================================================
              23. BROWSER CONTROL BRIDGE
              ================================================================ */}
          {currentSection === 'browser_control' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                🧭 {t('browserControl.title', language)}
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                Target: <code>{localBridgeState.targetId}</code> · Generation:{' '}
                <strong>#{localBridgeState.controlGeneration}</strong>
                {pairingTicket ? ` · Ticket: ${pairingTicket.pair_code}` : ''}
              </div>
              <button
                type="button"
                className="tg-btn tg-btn--primary"
                onClick={() => {
                  closeSettings();
                  setActiveNavDest('browser_control');
                }}
              >
                🧭 {isZh ? '打开浏览器接管工作台' : 'Open Browser Control Workspace'}
              </button>
            </div>
          )}

          {/* ================================================================
              24. WALLET & TELEGRAM STARS
              ================================================================ */}
          {currentSection === 'wallet' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>
                ⭐ {t('wallet.title', language)}
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#E5A030' }}>
                ★ {wallet?.stars_balance ?? wallet?.balance ?? 0} Stars
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

          {/* ================================================================
              25. ABOUT & KEYBOARD SHORTCUTS
              ================================================================ */}
          {currentSection === 'about' && (
            <div className="tg-surface-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '16px', fontWeight: 700 }}>
                GPUI Telegram Web · v1.3.0
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)', lineHeight: 1.5 }}>
                {isZh
                  ? '全栈协议对齐桌面端的 Web 客户端：兼容 gpui_telegram_server v1.3.0、全球法布施 3D WASM 小程序、WebCrypto ECDH P-256 + AES-256-GCM 端到端加密私密对话、WebRTC 音视频与屏幕共享，以及 Hermes + Magpie 智能体工作台。'
                  : 'Protocol-aligned TypeScript Web client for gpui_telegram_server v1.3.0 featuring the 3D Fabushi WASM Mini App, WebCrypto ECDH P-256 + AES-256-GCM Secret Chats, WebRTC Calls & Screen Share, and Hermes + Magpie AI Workspaces.'}
              </div>

              <button
                type="button"
                className="tg-btn tg-btn--primary"
                onClick={openShortcutsModalImperatively}
              >
                ⌨️ {isZh ? '查看键盘快捷键 (?)' : 'Keyboard Shortcuts (?)'}
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
};

export default SettingsPanel;
