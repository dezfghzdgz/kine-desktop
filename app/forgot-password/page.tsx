'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useLanguage } from '@/lib/i18n';
import Turnstile, { TURNSTILE_SITE_KEY, isCaptchaError, type TurnstileHandle } from '@/components/Turnstile';
import UiIcon from '@/components/UiIcon';

/**
 * Zapomenuté heslo: Supabase pošle e-mail s odkazem na /reset-password.
 * Odpověď je stejná, ať účet s e-mailem existuje, nebo ne (nejde tak
 * zjišťovat, kdo je na Kine registrovaný). Texty ve všech jazycích Kine.
 */
export default function ForgotPasswordPage() {
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ochrana proti botům (components/Turnstile.tsx) - token na jeden pokus.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError(t('captchaWait'));
      return;
    }
    setLoading(true);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
      ...(captchaToken ? { captchaToken } : {}),
    });
    turnstile.current?.reset();

    setLoading(false);

    if (resetError) {
      // Supabase pustí jeden e-mail za minutu - ať je jasné proč (ne anglická hláška ze serveru).
      const tooFast = resetError.status === 429 || /rate|seconds|security purposes|too many/i.test(resetError.message ?? '');
      setError(isCaptchaError(resetError.message) ? t('captchaFailed') : tooFast ? t('forgotPwTooFast') : t('forgotPwFailed'));
      return;
    }
    setSent(true);
  }

  return (
    <form className="form-container auth-card" onSubmit={handleSubmit}>
      <span className="auth-card-icon" aria-hidden="true">
        <UiIcon name="lock" size={22} />
      </span>
      <h1>{t('forgotPwTitle')}</h1>

      {sent ? (
        <>
          <p className="auth-card-text">{t('forgotPwSent')}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setSent(false);
              setError(null);
            }}
          >
            {t('forgotPwOtherEmail')}
          </button>
        </>
      ) : (
        <>
          <p className="auth-card-text">{t('forgotPwIntro')}</p>
          <input
            type="email"
            placeholder={t('email')}
            aria-label={t('email')}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <Turnstile ref={turnstile} action="reset" onToken={setCaptchaToken} />
          <button type="submit" disabled={loading}>
            {loading ? t('forgotPwSending') : t('forgotPwSend')}
          </button>
        </>
      )}

      <Link href="/login" className="auth-card-back">
        ← {t('forgotPwBack')}
      </Link>
    </form>
  );
}
