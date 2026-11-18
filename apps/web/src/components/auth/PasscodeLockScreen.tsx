import React, { useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';
import { t } from '../../i18n';
import { useAuthStore } from '../../store/useAuthStore';
import { useSettingsStore } from '../../store/useSettingsStore';

export interface PasscodeLockScreenProps {
  className?: string;
}

export const PasscodeLockScreen: React.FC<PasscodeLockScreenProps> = ({ className }) => {
  const language = useSettingsStore((s) => s.language);
  const currentUser = useAuthStore((s) => s.currentUser);
  const passcodeError = useAuthStore((s) => s.passcodeError);
  const unlockApp = useAuthStore((s) => s.unlockApp);

  const [passcode, setPasscode] = useState<string>('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!passcode) {
      setLocalError(t('passcode.invalid', language));
      return;
    }

    setSubmitting(true);
    setLocalError(null);
    try {
      const ok = await unlockApp(passcode);
      if (!ok) {
        setLocalError(t('passcode.invalid', language));
        setPasscode('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const errorMessage = localError || passcodeError;

  return (
    <div id={DOM_IDS.PASSCODE_LOCK_SCREEN} className={className}>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="tg-surface-card"
        style={{
          width: '100%',
          maxWidth: '380px',
          padding: '32px 26px',
          borderRadius: 'var(--tg-radius-lg)',
          boxShadow: 'var(--tg-shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: '58px',
            height: '58px',
            borderRadius: '50%',
            backgroundColor: 'var(--tg-accent-soft)',
            color: 'var(--tg-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <h1 style={{ margin: 0, fontSize: '19px', fontWeight: 700 }}>
            {t('passcode.lockedTitle', language)}
          </h1>
          {currentUser && (
            <span style={{ fontSize: '13px', color: 'var(--tg-text-secondary)' }}>
              {currentUser.firstName} {currentUser.lastName ?? ''}
              {currentUser.username ? ` (@${currentUser.username})` : ''}
            </span>
          )}
        </div>

        {errorMessage && (
          <div
            role="alert"
            aria-live="assertive"
            data-testid="passcode-error-alert"
            style={{
              width: '100%',
              padding: '9px 12px',
              borderRadius: 'var(--tg-radius-sm)',
              backgroundColor: 'var(--tg-danger-soft)',
              color: 'var(--tg-danger)',
              border: '1px solid var(--tg-danger)',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            {errorMessage}
          </div>
        )}

        <input
          id={DOM_IDS.PASSCODE_UNLOCK_INPUT}
          type="password"
          autoFocus
          value={passcode}
          onChange={(e) => {
            setPasscode(e.target.value);
            if (localError) setLocalError(null);
          }}
          placeholder={t('passcode.placeholder', language)}
          aria-label={t('passcode.placeholder', language)}
          className="tg-input"
          style={{ textAlign: 'center', letterSpacing: '3px', fontSize: '16px' }}
        />

        <button
          type="submit"
          disabled={submitting}
          className="tg-btn tg-btn--primary"
          style={{ width: '100%', padding: '10px 16px', fontWeight: 600 }}
        >
          {t('passcode.unlock', language)}
        </button>

        <span style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary)' }}>
          {t('passcode.shortcutHint', language)}
        </span>
      </form>
    </div>
  );
};
