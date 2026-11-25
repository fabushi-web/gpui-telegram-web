import React, { useEffect, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useSettingsStore, type ThemeName } from '../../store/useSettingsStore';
import { QrMatrixSvg } from './qrSvgMatrix';

export interface AuthScreenProps {
  className?: string;
}

type AuthTabId = 'password' | 'alipay' | 'email' | 'phone' | 'qr';

interface CountryOption {
  code: string;
  dial: string;
  label: string;
}

const COUNTRY_OPTIONS: CountryOption[] = [
  { code: 'CN', dial: '+86', label: '+86 China (中国)' },
  { code: 'US', dial: '+1', label: '+1 USA / Canada' },
  { code: 'GB', dial: '+44', label: '+44 United Kingdom' },
  { code: 'JP', dial: '+81', label: '+81 Japan (日本)' },
  { code: 'SG', dial: '+65', label: '+65 Singapore (新加坡)' },
  { code: 'DE', dial: '+49', label: '+49 Germany' },
  { code: 'FR', dial: '+33', label: '+33 France' },
  { code: 'KR', dial: '+82', label: '+82 South Korea' },
  { code: 'HK', dial: '+852', label: '+852 Hong Kong' },
  { code: 'IN', dial: '+91', label: '+91 India' },
];

const THEME_OPTIONS: Array<{ id: ThemeName; key: string }> = [
  { id: 'night', key: 'settings.theme.night' },
  { id: 'tinted', key: 'settings.theme.tinted' },
  { id: 'day', key: 'settings.theme.day' },
  { id: 'classic', key: 'settings.theme.classic' },
];

const SERVER_PRESETS: Array<{ labelZh: string; labelEn: string; url: string }> = [
  { labelZh: '当前站点', labelEn: 'Same Origin', url: '' },
  { labelZh: 'web.ombhrum.com', labelEn: 'web.ombhrum.com', url: 'https://web.ombhrum.com' },
];

export const AuthScreen: React.FC<AuthScreenProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const toggleLanguage = useSettingsStore((s) => s.toggleLanguage);

  const serverUrl = useAuthStore((s) => s.serverUrl);
  const serverHealth = useAuthStore((s) => s.serverHealth);
  const isAddingAccount = useAuthStore((s) => s.isAddingAccount);
  const isLoading = useAuthStore((s) => s.isLoading);
  const storeError = useAuthStore((s) => s.error);
  const phoneCodeHash = useAuthStore((s) => s.phoneCodeHash);
  const pendingPhone = useAuthStore((s) => s.pendingPhone);
  const requires2fa = useAuthStore((s) => s.requires2fa);
  const twoFaHint = useAuthStore((s) => s.twoFaHint);
  const qrSession = useAuthStore((s) => s.qrSession);
  const emailCodeHash = useAuthStore((s) => s.emailCodeHash);
  const pendingEmail = useAuthStore((s) => s.pendingEmail);
  const alipaySession = useAuthStore((s) => s.alipaySession);

  const clearError = useAuthStore((s) => s.clearError);
  const setServerUrl = useAuthStore((s) => s.setServerUrl);
  const probeServerHealth = useAuthStore((s) => s.probeServerHealth);
  const sendPhoneCode = useAuthStore((s) => s.sendPhoneCode);
  const verifyPhoneCode = useAuthStore((s) => s.verifyPhoneCode);
  const verify2fa = useAuthStore((s) => s.verify2fa);
  const startQrPairing = useAuthStore((s) => s.startQrPairing);
  const pollQrPairing = useAuthStore((s) => s.pollQrPairing);
  const loginPassword = useAuthStore((s) => s.loginPassword);
  const registerPassword = useAuthStore((s) => s.registerPassword);
  const sendEmailCode = useAuthStore((s) => s.sendEmailCode);
  const verifyEmailCode = useAuthStore((s) => s.verifyEmailCode);
  const registerEmail = useAuthStore((s) => s.registerEmail);
  const startAlipay = useAuthStore((s) => s.startAlipay);
  const pollAlipay = useAuthStore((s) => s.pollAlipay);
  const loginPasskey = useAuthStore((s) => s.loginPasskey);
  const cancelAddAccountFlow = useAuthStore((s) => s.cancelAddAccountFlow);

  const [activeTab, setActiveTab] = useState<AuthTabId>('password');
  const [localError, setLocalError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Top bar state
  const [serverUrlDraft, setServerUrlDraft] = useState<string>(serverUrl);

  // Phone OTP state
  const [selectedDial, setSelectedDial] = useState<string>('+86');
  const [phoneInput, setPhoneInput] = useState<string>('+86 ');
  const [otpInput, setOtpInput] = useState<string>('');

  // 2FA state
  const [twoFaPassword, setTwoFaPassword] = useState<string>('');

  // Password login/register state (Split-Key V2)
  const [isRegisterMode, setIsRegisterMode] = useState<boolean>(false);
  const [usernameInput, setUsernameInput] = useState<string>('');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [firstNameInput, setFirstNameInput] = useState<string>('');

  // Email OTP / Registration state
  const [emailInput, setEmailInput] = useState<string>('');
  const [emailOtpInput, setEmailOtpInput] = useState<string>('');
  const [emailRegisterMode, setEmailRegisterMode] = useState<boolean>(false);
  const [emailRegUsername, setEmailRegUsername] = useState<string>('');
  const [emailRegPassword, setEmailRegPassword] = useState<string>('');
  const [emailRegFirstName, setEmailRegFirstName] = useState<string>('');

  useEffect(() => {
    setServerUrlDraft(serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    if (serverHealth.status === 'unknown') {
      void probeServerHealth(serverUrl);
    }
  }, [serverHealth.status, serverUrl, probeServerHealth]);

  // Start & auto-poll QR pairing via POST /api/v1/auth/pair/create + GET /api/v1/auth/pair/status
  useEffect(() => {
    if (activeTab !== 'qr' || requires2fa) return;
    let cancelled = false;
    void startQrPairing('Fabushi Web').catch(() => undefined);

    const timer = setInterval(() => {
      if (cancelled) return;
      void pollQrPairing().catch(() => undefined);
    }, 1200);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTab, requires2fa, startQrPairing, pollQrPairing]);

  // Start & auto-poll Alipay QR session when Alipay tab is active
  useEffect(() => {
    if (activeTab !== 'alipay' || requires2fa) return;
    let cancelled = false;
    void startAlipay().catch(() => undefined);

    const timer = setInterval(() => {
      if (cancelled) return;
      void pollAlipay().catch(() => undefined);
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTab, requires2fa, startAlipay, pollAlipay]);

  const switchTab = (tab: AuthTabId): void => {
    setActiveTab(tab);
    setLocalError(null);
    setStatusNotice(null);
    clearError();
  };

  const handleCountryChange = (nextDial: string): void => {
    const prevDial = selectedDial;
    setSelectedDial(nextDial);
    const trimmed = phoneInput.trim();
    if (!trimmed || trimmed === prevDial) {
      setPhoneInput(`${nextDial} `);
    } else if (trimmed.startsWith(prevDial)) {
      setPhoneInput(`${nextDial}${trimmed.slice(prevDial.length)}`);
    } else if (!trimmed.startsWith('+')) {
      setPhoneInput(`${nextDial} ${trimmed}`);
    }
  };

  const normalizePhoneForSubmit = (raw: string): string => {
    const trimmed = raw.trim();
    const withPrefix = trimmed.startsWith('+') ? trimmed : `${selectedDial}${trimmed}`;
    return `+${withPrefix.replace(/[^\d]/g, '')}`;
  };

  const handleSendPhoneOtp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    const normalized = normalizePhoneForSubmit(phoneInput);
    const digitCount = normalized.replace(/\D/g, '').length;
    if (digitCount < 7) {
      setLocalError(
        language === 'zh-CN'
          ? '手机号格式无效：请输入至少 7 位有效数字'
          : 'Invalid phone number: must contain at least 7 digits.',
      );
      return;
    }

    try {
      setOtpInput('');
      await sendPhoneCode(normalized);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVerifyPhoneOtp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    const cleanCode = otpInput.trim();
    if (cleanCode.length < 4) {
      setLocalError(
        language === 'zh-CN' ? '请输入有效的短信验证码' : 'Please enter a valid verification code.',
      );
      return;
    }

    try {
      await verifyPhoneCode({
        phone: pendingPhone ?? normalizePhoneForSubmit(phoneInput),
        code: cleanCode,
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit2fa = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    if (!twoFaPassword.trim()) {
      setLocalError(
        language === 'zh-CN' ? '请输入两步验证云密码' : 'Please enter your 2FA cloud password.',
      );
      return;
    }

    try {
      await verify2fa(twoFaPassword);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    const cleanUser = usernameInput.trim().replace(/^@/, '');
    if (cleanUser.length < 2) {
      setLocalError(
        language === 'zh-CN' ? '请输入有效的用户名' : 'Please enter a valid username.',
      );
      return;
    }
    if (passwordInput.length < 4) {
      setLocalError(
        language === 'zh-CN' ? '密码长度至少为 4 位' : 'Password must be at least 4 characters.',
      );
      return;
    }

    try {
      if (isRegisterMode) {
        await registerPassword({
          username: cleanUser,
          password: passwordInput,
          firstName: firstNameInput.trim() || cleanUser,
        });
      } else {
        await loginPassword(cleanUser, passwordInput);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSendEmailOtp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    const cleanEmail = emailInput.trim();
    if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      setLocalError(
        language === 'zh-CN' ? '请输入有效的电子邮箱地址' : 'Please enter a valid email address.',
      );
      return;
    }

    try {
      setEmailOtpInput('');
      await sendEmailCode(cleanEmail);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVerifyEmailOtp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    const cleanCode = emailOtpInput.trim();
    if (cleanCode.length < 4) {
      setLocalError(
        language === 'zh-CN' ? '请输入有效的邮箱验证码' : 'Please enter the email verification code.',
      );
      return;
    }

    try {
      if (emailRegisterMode) {
        const cleanUser = emailRegUsername.trim().replace(/^@/, '');
        if (cleanUser.length < 2) {
          setLocalError(
            language === 'zh-CN' ? '请设置至少 2 位用户名' : 'Username must be at least 2 characters.',
          );
          return;
        }
        if (emailRegPassword.length < 6) {
          setLocalError(
            language === 'zh-CN' ? '请设置至少 6 位登录密码' : 'Password must be at least 6 characters.',
          );
          return;
        }
        await registerEmail({
          email: pendingEmail ?? emailInput.trim(),
          code: cleanCode,
          username: cleanUser,
          password: emailRegPassword,
          firstName: emailRegFirstName.trim() || cleanUser,
        });
      } else {
        await verifyEmailCode({
          email: pendingEmail ?? emailInput.trim(),
          code: cleanCode,
        });
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveServerUrl = async (e?: React.FormEvent, explicitUrl?: string): Promise<void> => {
    e?.preventDefault();
    const target = (explicitUrl !== undefined ? explicitUrl : serverUrlDraft).trim();
    setServerUrlDraft(target);
    setServerUrl(target);
    const snap = await probeServerHealth(target);
    setStatusNotice(
      snap.ok
        ? language === 'zh-CN'
          ? `已连接服务器：${target || window.location.origin} (${snap.latencyMs}ms)`
          : `Connected to ${target || window.location.origin} (${snap.latencyMs}ms)`
        : language === 'zh-CN'
          ? `服务器地址已保存，但连通性检测失败：${snap.error ?? '无法连接'}`
          : `Server URL saved, probe failed: ${snap.error ?? 'Unreachable'}`,
    );
  };

  const handlePasskeyAuth = async (): Promise<void> => {
    setLocalError(null);
    clearError();
    try {
      await loginPasskey(usernameInput.trim() || undefined);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const displayedError = localError || storeError;
  const isPhoneCodeStep = Boolean(phoneCodeHash);
  const isEmailCodeStep = Boolean(emailCodeHash);

  const tabs: Array<{ id: AuthTabId; domId: string; label: string }> = [
    { id: 'password', domId: DOM_IDS.TAB_AUTH_PASSWORD, label: t('auth.tab.password', language) },
    { id: 'alipay', domId: DOM_IDS.TAB_AUTH_ALIPAY, label: t('auth.tab.alipay', language) },
    { id: 'email', domId: DOM_IDS.TAB_AUTH_EMAIL, label: t('auth.tab.email', language) },
    { id: 'phone', domId: DOM_IDS.TAB_AUTH_PHONE, label: t('auth.tab.phone', language) },
    { id: 'qr', domId: DOM_IDS.TAB_AUTH_QR, label: t('auth.tab.qr', language) },
  ];

  return (
    <div
      id={DOM_IDS.AUTH_SCREEN}
      className={className}
      style={{
        flexDirection: 'column',
        justifyContent: 'flex-start',
        gap: '16px',
        paddingTop: '16px',
        paddingBottom: '32px',
      }}
    >
      {/* Top Quick Controls Bar: Theme, Language, Server URL & Live Connection Status */}
      <header
        style={{
          width: '100%',
          maxWidth: '960px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '10px 14px',
          borderRadius: 'var(--tg-radius-md)',
          backgroundColor: 'var(--tg-bg-surface)',
          border: '1px solid var(--tg-border)',
        }}
      >
        {/* Theme & Language Quick Switches */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
          {THEME_OPTIONS.map((opt) => {
            const active = theme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                data-theme-option={opt.id}
                aria-pressed={active}
                onClick={() => setTheme(opt.id)}
                className="tg-btn"
                style={{
                  padding: '5px 10px',
                  fontSize: '12px',
                  backgroundColor: active ? 'var(--tg-accent-soft)' : 'transparent',
                  color: active ? 'var(--tg-accent)' : 'var(--tg-text-secondary)',
                  border: active ? '1px solid var(--tg-accent)' : '1px solid var(--tg-border-subtle)',
                }}
              >
                {t(opt.key, language)}
              </button>
            );
          })}

          <button
            type="button"
            onClick={toggleLanguage}
            className="tg-btn tg-btn--secondary"
            aria-label={t('menu.language', language)}
            style={{ padding: '5px 10px', fontSize: '12px' }}
          >
            {language === 'zh-CN' ? '中文 / EN' : 'EN / 中文'}
          </button>
        </div>

        {/* Live Server Health Pill & Server Endpoint Selector */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
          <span
            data-testid="server-health-pill"
            style={{
              fontSize: '11.5px',
              fontWeight: 600,
              padding: '4px 9px',
              borderRadius: 'var(--tg-radius-pill)',
              backgroundColor:
                serverHealth.status === 'online'
                  ? 'var(--tg-success-soft)'
                  : serverHealth.status === 'offline'
                    ? 'var(--tg-danger-soft)'
                    : 'var(--tg-info-soft)',
              color:
                serverHealth.status === 'online'
                  ? 'var(--tg-success)'
                  : serverHealth.status === 'offline'
                    ? 'var(--tg-danger)'
                    : 'var(--tg-info)',
            }}
            title={serverHealth.error || serverHealth.server || ''}
          >
            {serverHealth.status === 'online'
              ? language === 'zh-CN'
                ? `● 已连接${serverHealth.latencyMs ? ` ${serverHealth.latencyMs}ms` : ''}`
                : `● Connected${serverHealth.latencyMs ? ` ${serverHealth.latencyMs}ms` : ''}`
              : serverHealth.status === 'offline'
                ? language === 'zh-CN'
                  ? '● 无法连接'
                  : '● Offline'
                : language === 'zh-CN'
                  ? '○ 检测中...'
                  : '○ Checking...'}
          </span>

          <form
            onSubmit={(e) => void handleSaveServerUrl(e)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <input
              id={DOM_IDS.AUTH_SERVER_URL_INPUT}
              type="text"
              value={serverUrlDraft}
              onChange={(e) => setServerUrlDraft(e.target.value)}
              placeholder={
                language === 'zh-CN'
                  ? '服务器地址（留空即同源）'
                  : 'Server URL (empty = same origin)'
              }
              aria-label={t('auth.adapter.serverUrl', language)}
              className="tg-input"
              style={{ width: '195px', padding: '5px 9px', fontSize: '12px' }}
            />
            <button
              type="submit"
              className="tg-btn tg-btn--secondary"
              style={{ padding: '5px 10px', fontSize: '12px' }}
            >
              {language === 'zh-CN' ? '连接' : 'Connect'}
            </button>
          </form>
        </div>
      </header>

      {/* Main Centered Onboarding Card */}
      <div
        className="tg-surface-card"
        style={{
          width: '100%',
          maxWidth: '470px',
          margin: 'auto 0',
          padding: '28px 26px',
          borderRadius: 'var(--tg-radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        {isAddingAccount && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--tg-accent)',
                backgroundColor: 'var(--tg-accent-soft)',
                padding: '3px 10px',
                borderRadius: 'var(--tg-radius-pill)',
              }}
            >
              {t('menu.addAccount', language)}
            </span>
            <button
              type="button"
              onClick={cancelAddAccountFlow}
              className="tg-btn tg-btn--secondary"
              style={{ padding: '4px 10px', fontSize: '12px' }}
            >
              ← {t('common.cancel', language)}
            </button>
          </div>
        )}

        {/* Brand Mark & Primary H1 Heading */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '8px' }}>
          <div
            aria-hidden="true"
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'linear-gradient(180deg, #299BFF 0%, #0A84FF 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <path
                d="M47.4 20.6L20.4 31.0c-1.2.45-1.2 2.05 0 2.5l6.85 2.35 2.65 8.0c.3 1.0 1.6 1.3 2.35.6l3.95-3.8 7.0 5.1c.9.7 2.2.15 2.5-1.0L49.5 22.5c.3-1.3-.9-2.3-2.1-1.9zM29.6 36.2l13.0-11.0-10.35 12.85-.45 4.5-2.2-6.35z"
                fill="#FFFFFF"
              />
            </svg>
          </div>
          <h1 style={{ margin: 0, fontSize: '21px', fontWeight: 700, color: 'var(--tg-text-primary)' }}>
            {t('auth.title', language)}
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--tg-text-secondary)' }}>
            {t('auth.subtitle', language)} · Fabushi Web v1.6.11
          </p>
        </div>

        {/* Quick Server Presets when offline or switching backend */}
        {serverHealth.status === 'offline' && (
          <div
            role="status"
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--tg-radius-sm)',
              backgroundColor: 'var(--tg-warning-soft)',
              border: '1px solid var(--tg-warning)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              fontSize: '12px',
            }}
          >
            <div style={{ color: 'var(--tg-warning)', fontWeight: 600 }}>
              {language === 'zh-CN'
                ? `当前无法连接到后端服务 (${serverUrl || window.location.origin})，可快速切换或重测：`
                : `Unable to reach server (${serverUrl || window.location.origin}). Choose an endpoint:`}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {SERVER_PRESETS.map((preset) => (
                <button
                  key={preset.labelEn}
                  type="button"
                  className="tg-btn tg-btn--secondary"
                  style={{ padding: '4px 8px', fontSize: '11.5px' }}
                  onClick={() => void handleSaveServerUrl(undefined, preset.url)}
                >
                  {language === 'zh-CN' ? preset.labelZh : preset.labelEn}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Status / Error Alerts */}
        {statusNotice && !displayedError && (
          <div
            role="status"
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--tg-radius-sm)',
              backgroundColor: 'var(--tg-info-soft)',
              color: 'var(--tg-info)',
              fontSize: '12.5px',
            }}
          >
            {statusNotice}
          </div>
        )}

        {displayedError && (
          <div
            role="alert"
            aria-live="assertive"
            data-testid="auth-error-alert"
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--tg-radius-sm)',
              backgroundColor: 'var(--tg-danger-soft)',
              color: 'var(--tg-danger)',
              border: '1px solid var(--tg-danger)',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            {displayedError}
          </div>
        )}

        {/* Cloud 2FA Password Challenge Gate (triggered from Phone, Email, or Password auth) */}
        {requires2fa ? (
          <form
            onSubmit={(e) => void handleSubmit2fa(e)}
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <strong style={{ fontSize: '15px' }}>{t('auth.twoFa.title', language)}</strong>
              <span style={{ fontSize: '12.5px', color: 'var(--tg-text-secondary)' }}>
                {t('auth.twoFa.subtitle', language)}
              </span>
              {twoFaHint && (
                <span
                  data-testid="two-fa-hint"
                  style={{ fontSize: '12.5px', color: 'var(--tg-accent)', fontWeight: 500 }}
                >
                  {t('auth.twoFa.hint', language)}: {twoFaHint}
                </span>
              )}
            </div>

            <input
              id={DOM_IDS.AUTH_2FA_INPUT}
              type="password"
              autoFocus
              value={twoFaPassword}
              onChange={(e) => setTwoFaPassword(e.target.value)}
              placeholder={t('auth.twoFa.placeholder', language)}
              aria-label={t('auth.twoFa.placeholder', language)}
              className="tg-input"
            />

            <button
              id={DOM_IDS.BTN_AUTH_SUBMIT_2FA}
              type="submit"
              disabled={isLoading}
              className="tg-btn tg-btn--primary"
              style={{ width: '100%', padding: '10px 16px' }}
            >
              {t('auth.twoFa.submit', language)}
            </button>

            <button
              type="button"
              onClick={() => {
                setTwoFaPassword('');
                setLocalError(null);
                useAuthStore.setState({
                  requires2fa: false,
                  twoFaChallengeToken: null,
                  error: null,
                });
              }}
              className="tg-btn tg-btn--ghost"
              style={{ width: '100%' }}
            >
              ← {t('common.back', language)}
            </button>
          </form>
        ) : (
          <>
            {/* 5 Canonical Desktop-Aligned Auth Mode Tabs */}
            <div
              role="tablist"
              aria-label="Authentication Modes"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                gap: '4px',
                padding: '4px',
                borderRadius: 'var(--tg-radius-md)',
                backgroundColor: 'var(--tg-bg-input)',
                border: '1px solid var(--tg-border-subtle)',
              }}
            >
              {tabs.map((tab) => {
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    id={tab.domId}
                    role="tab"
                    type="button"
                    aria-selected={selected}
                    onClick={() => switchTab(tab.id)}
                    style={{
                      padding: '7px 4px',
                      borderRadius: 'var(--tg-radius-sm)',
                      fontSize: '12px',
                      fontWeight: selected ? 600 : 500,
                      backgroundColor: selected ? 'var(--tg-bg-surface)' : 'transparent',
                      color: selected ? 'var(--tg-accent)' : 'var(--tg-text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Tab 1: Username & Password Login / Split-Key V2 Register */}
            {activeTab === 'password' && (
              <div role="tabpanel" aria-labelledby={DOM_IDS.TAB_AUTH_PASSWORD}>
                <form
                  onSubmit={(e) => void handlePasswordSubmit(e)}
                  style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
                >
                  <input
                    id={DOM_IDS.AUTH_USERNAME_INPUT}
                    type="text"
                    name="username"
                    autoComplete="username"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    placeholder={t('auth.password.username', language)}
                    aria-label={t('auth.password.username', language)}
                    className="tg-input"
                  />

                  {isRegisterMode && (
                    <input
                      type="text"
                      name="firstName"
                      value={firstNameInput}
                      onChange={(e) => setFirstNameInput(e.target.value)}
                      placeholder={t('auth.password.firstName', language)}
                      aria-label={t('auth.password.firstName', language)}
                      className="tg-input"
                    />
                  )}

                  <input
                    id={DOM_IDS.AUTH_PASSWORD_INPUT}
                    type="password"
                    name="password"
                    autoComplete={isRegisterMode ? 'new-password' : 'current-password'}
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder={t('auth.password.password', language)}
                    aria-label={t('auth.password.password', language)}
                    className="tg-input"
                  />

                  <button
                    id={DOM_IDS.BTN_AUTH_PASSWORD_SUBMIT}
                    type="submit"
                    disabled={isLoading}
                    className="tg-btn tg-btn--primary"
                    style={{ width: '100%', padding: '10px 16px' }}
                  >
                    {isRegisterMode
                      ? t('auth.password.registerSubmit', language)
                      : t('auth.password.loginSubmit', language)}
                  </button>

                  <button
                    id={DOM_IDS.AUTH_MODE_REGISTER_TOGGLE}
                    type="button"
                    data-mode={isRegisterMode ? 'register' : 'login'}
                    aria-pressed={isRegisterMode}
                    onClick={() => {
                      setIsRegisterMode((v) => !v);
                      setLocalError(null);
                      clearError();
                    }}
                    className="tg-btn tg-btn--ghost"
                    style={{ width: '100%', fontSize: '13px' }}
                  >
                    {isRegisterMode
                      ? t('auth.password.switchToLogin', language)
                      : t('auth.password.switchToRegister', language)}
                  </button>
                </form>
              </div>
            )}

            {/* Tab 2: Alipay OAuth Real Scannable QR Session */}
            {activeTab === 'alipay' && (
              <div
                role="tabpanel"
                aria-labelledby={DOM_IDS.TAB_AUTH_ALIPAY}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '12px',
                  textAlign: 'center',
                }}
              >
                {alipaySession?.qr_url ? (
                  <QrMatrixSvg
                    id={DOM_IDS.QR_LOGIN_SVG}
                    size={208}
                    value={alipaySession.qr_url}
                    accentColor="#1677FF"
                    badge="alipay"
                  />
                ) : (
                  <div
                    style={{
                      width: '208px',
                      height: '208px',
                      borderRadius: '14px',
                      backgroundColor: 'var(--tg-bg-elevated)',
                      border: '1px solid var(--tg-border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12.5px',
                      color: 'var(--tg-text-secondary)',
                      padding: '16px',
                    }}
                  >
                    {language === 'zh-CN' ? '正在生成支付宝授权二维码...' : 'Loading Alipay QR...'}
                  </div>
                )}

                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                  {t('auth.alipay.title', language)}
                </div>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                  {language === 'zh-CN'
                    ? '打开支付宝 App 扫描上方二维码授权登录，或在浏览器中打开授权页面。'
                    : 'Scan with Alipay App or open the Alipay authorization link in your browser.'}
                </p>

                <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                  {alipaySession?.qr_url && /^https?:\/\//i.test(alipaySession.qr_url) && (
                    <a
                      href={alipaySession.qr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tg-btn tg-btn--primary"
                      style={{ flex: 1, textDecoration: 'none', padding: '9px 12px', fontSize: '13px' }}
                    >
                      {language === 'zh-CN' ? '在浏览器打开支付宝授权' : 'Open Alipay Auth'}
                    </a>
                  )}
                  <button
                    type="button"
                    className="tg-btn tg-btn--secondary"
                    disabled={isLoading}
                    onClick={() => void startAlipay().catch(() => undefined)}
                    style={{ padding: '9px 12px', fontSize: '13px' }}
                  >
                    ↻ {language === 'zh-CN' ? '刷新二维码' : 'Refresh'}
                  </button>
                </div>
              </div>
            )}

            {/* Tab 3: Email OTP Sign-in & Split-Key V2 Email Registration */}
            {activeTab === 'email' && (
              <div role="tabpanel" aria-labelledby={DOM_IDS.TAB_AUTH_EMAIL}>
                {!isEmailCodeStep ? (
                  <form
                    onSubmit={(e) => void handleSendEmailOtp(e)}
                    style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
                  >
                    <input
                      type="email"
                      name="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="name@ombhrum.com"
                      aria-label={t('auth.email.label', language)}
                      className="tg-input"
                    />
                    <button
                      id={DOM_IDS.BTN_AUTH_SEND_CODE}
                      type="submit"
                      disabled={isLoading}
                      className="tg-btn tg-btn--primary"
                      style={{ width: '100%', padding: '10px 16px' }}
                    >
                      {t('auth.email.sendCode', language)}
                    </button>
                  </form>
                ) : (
                  <form
                    onSubmit={(e) => void handleVerifyEmailOtp(e)}
                    style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '12.5px',
                        color: 'var(--tg-text-secondary)',
                      }}
                    >
                      <span>
                        {t('auth.email.label', language)}: <strong>{pendingEmail ?? emailInput}</strong>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setEmailOtpInput('');
                          setLocalError(null);
                          useAuthStore.setState({
                            emailCodeHash: null,
                            pendingEmail: null,
                            error: null,
                          });
                        }}
                        className="tg-btn tg-btn--ghost"
                        style={{ padding: '2px 8px', fontSize: '12px' }}
                      >
                        {t('common.back', language)}
                      </button>
                    </div>

                    <input
                      id={DOM_IDS.AUTH_CODE_INPUT}
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      value={emailOtpInput}
                      onChange={(e) => setEmailOtpInput(e.target.value)}
                      placeholder={t('auth.phone.codePlaceholder', language)}
                      aria-label={t('auth.phone.codeLabel', language)}
                      className="tg-input"
                    />

                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                      <input
                        type="checkbox"
                        checked={emailRegisterMode}
                        onChange={(e) => setEmailRegisterMode(e.target.checked)}
                      />
                      <span>
                        {language === 'zh-CN'
                          ? '新用户注册（同步设置用户名与密码）'
                          : 'New account registration (set username & password)'}
                      </span>
                    </label>

                    {emailRegisterMode && (
                      <>
                        <input
                          type="text"
                          value={emailRegUsername}
                          onChange={(e) => setEmailRegUsername(e.target.value)}
                          placeholder={t('auth.password.username', language)}
                          className="tg-input"
                        />
                        <input
                          type="text"
                          value={emailRegFirstName}
                          onChange={(e) => setEmailRegFirstName(e.target.value)}
                          placeholder={t('auth.password.firstName', language)}
                          className="tg-input"
                        />
                        <input
                          type="password"
                          value={emailRegPassword}
                          onChange={(e) => setEmailRegPassword(e.target.value)}
                          placeholder={language === 'zh-CN' ? '设置密码（至少 6 位）' : 'Password (min 6 chars)'}
                          className="tg-input"
                        />
                      </>
                    )}

                    <button
                      type="submit"
                      disabled={isLoading}
                      className="tg-btn tg-btn--primary"
                      style={{ width: '100%', padding: '10px 16px' }}
                    >
                      {emailRegisterMode
                        ? language === 'zh-CN'
                          ? '完成邮箱注册'
                          : 'Complete Email Registration'
                        : t('auth.email.verify', language)}
                    </button>
                  </form>
                )}
              </div>
            )}

            {/* Tab 4: Phone + Country Selector + OTP */}
            {activeTab === 'phone' && (
              <div role="tabpanel" aria-labelledby={DOM_IDS.TAB_AUTH_PHONE}>
                {!isPhoneCodeStep ? (
                  <form
                    onSubmit={(e) => void handleSendPhoneOtp(e)}
                    style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
                  >
                    <select
                      id={DOM_IDS.AUTH_COUNTRY_SELECT}
                      value={selectedDial}
                      onChange={(e) => handleCountryChange(e.target.value)}
                      aria-label="Country or Region"
                      className="tg-select"
                    >
                      {COUNTRY_OPTIONS.map((c) => (
                        <option key={c.code} value={c.dial}>
                          {c.label}
                        </option>
                      ))}
                    </select>

                    <input
                      id={DOM_IDS.AUTH_PHONE_INPUT}
                      type="tel"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder={t('auth.phone.placeholder', language)}
                      aria-label={t('auth.phone.label', language)}
                      className="tg-input"
                    />

                    <button
                      id={DOM_IDS.BTN_AUTH_SEND_CODE}
                      type="submit"
                      disabled={isLoading}
                      className="tg-btn tg-btn--primary"
                      style={{ width: '100%', padding: '10px 16px' }}
                    >
                      {t('auth.phone.sendCode', language)}
                    </button>
                  </form>
                ) : (
                  <form
                    onSubmit={(e) => void handleVerifyPhoneOtp(e)}
                    style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '12.5px',
                        color: 'var(--tg-text-secondary)',
                      }}
                    >
                      <span>
                        {t('auth.phone.codeLabel', language)}: <strong>{pendingPhone}</strong>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setOtpInput('');
                          setLocalError(null);
                          useAuthStore.setState({
                            phoneCodeHash: null,
                            pendingPhone: null,
                            error: null,
                          });
                        }}
                        className="tg-btn tg-btn--ghost"
                        style={{ padding: '2px 8px', fontSize: '12px' }}
                      >
                        {t('common.back', language)}
                      </button>
                    </div>

                    <input
                      id={DOM_IDS.AUTH_CODE_INPUT}
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      value={otpInput}
                      onChange={(e) => setOtpInput(e.target.value)}
                      placeholder={t('auth.phone.codePlaceholder', language)}
                      aria-label={t('auth.phone.codeLabel', language)}
                      className="tg-input"
                    />

                    <button
                      type="submit"
                      disabled={isLoading}
                      className="tg-btn tg-btn--primary"
                      style={{ width: '100%', padding: '10px 16px' }}
                    >
                      {t('auth.phone.verify', language)}
                    </button>
                  </form>
                )}
              </div>
            )}

            {/* Tab 5: Real ISO/IEC 18004 QR Device Pairing */}
            {activeTab === 'qr' && (
              <div
                role="tabpanel"
                aria-labelledby={DOM_IDS.TAB_AUTH_QR}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '12px',
                  textAlign: 'center',
                }}
              >
                {qrSession?.qr_url ? (
                  <QrMatrixSvg
                    id={DOM_IDS.QR_LOGIN_SVG}
                    size={208}
                    value={qrSession.qr_url}
                    accentColor="#0A84FF"
                  />
                ) : (
                  <div
                    style={{
                      width: '208px',
                      height: '208px',
                      borderRadius: '14px',
                      backgroundColor: 'var(--tg-bg-elevated)',
                      border: '1px solid var(--tg-border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12.5px',
                      color: 'var(--tg-text-secondary)',
                      padding: '16px',
                    }}
                  >
                    {language === 'zh-CN' ? '正在生成设备配对二维码...' : 'Generating QR code...'}
                  </div>
                )}
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{t('auth.qr.title', language)}</div>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--tg-text-secondary)' }}>
                  {t('auth.qr.instructions', language)}
                </p>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => void startQrPairing('Fabushi Web').catch(() => undefined)}
                  className="tg-btn tg-btn--secondary"
                  style={{ width: '100%', padding: '9px 14px' }}
                >
                  ↻ {language === 'zh-CN' ? '刷新配对二维码' : 'Refresh QR Code'}
                </button>
              </div>
            )}

            {/* WebAuthn Passkey Login */}
            <div
              style={{
                paddingTop: '10px',
                borderTop: '1px solid var(--tg-border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <button
                id={DOM_IDS.BTN_AUTH_PASSKEY}
                type="button"
                disabled={isLoading}
                onClick={() => void handlePasskeyAuth()}
                className="tg-btn tg-btn--secondary"
                style={{ width: '100%', padding: '9px 14px', fontSize: '13px' }}
              >
                🔑 {t('auth.passkey.signIn', language)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
