'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { ensureOwnProfile } from '@/lib/ensureProfile';
import Toast, { ToastType } from '@/components/Toast';
import { useLanguage } from '@/lib/i18n';
import AuthPitch from '@/components/AuthPitch';
import UiIcon from '@/components/UiIcon';
import Turnstile, { TURNSTILE_SITE_KEY, isCaptchaError, type TurnstileHandle } from '@/components/Turnstile';

const LOCK_DURATION_MINUTES = 15;

export default function LoginPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  // Ochrana proti botům (components/Turnstile.tsx) - token na jeden pokus.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);

  // Volá appce vlastní API pro hlídání pokusů o přihlášení. Pokud tohle
  // API z jakéhokoliv důvodu selže (ještě neproběhla SQL migrace, výpadek
  // sítě...), appka to jen potichu přeskočí a pokračuje dál - přihlášení
  // samotné na tom nesmí nikdy zůstat "viset".
  async function callLockoutApi(action: 'check' | 'record-failure' | 'reset', accessToken?: string) {
    try {
      const res = await fetch('/api/login-attempt', {
        method: 'POST',
        // Vynulování počítadla server přijme jen s platným přihlášením.
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ email, action }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError(t('captchaWait'));
      return;
    }
    setLoading(true);

    try {
      // Nejdřív zkontrolujeme, jestli tenhle účet není dočasně uzamčený kvůli
      // předchozím opakovaným špatným pokusům.
      const lockCheck = await callLockoutApi('check');

      if (lockCheck?.locked) {
        const minutesLeft = Math.max(1, Math.ceil((new Date(lockCheck.lockedUntil).getTime() - Date.now()) / 60000));
        setError(`${t('accountLockedNote')} ${minutesLeft} ${t('minutesShortLabel')}.`);
        setLoading(false);
        return;
      }

      const { data, error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password,
        ...(captchaToken ? { options: { captchaToken } } : {}),
      });
      turnstile.current?.reset();

      // Ověření proti botům nevyšlo - to není špatné heslo, nepočítá se do zámku.
      if (loginError && isCaptchaError(loginError.message)) {
        setError(t('captchaFailed'));
        setLoading(false);
        return;
      }

      // Účet s nepotvrzeným e-mailem (Supabase -> Confirm email): heslo je dobře,
      // jen chybí kliknutí na odkaz - nepočítá se jako špatný pokus.
      if (loginError && ((loginError as { code?: string }).code === 'email_not_confirmed' || /email not confirmed/i.test(loginError.message ?? ''))) {
        setError(t('loginEmailNotConfirmed'));
        setLoading(false);
        return;
      }

      if (loginError) {
        const failData = await callLockoutApi('record-failure');

        if (failData?.locked) {
          setError(`${t('accountLockedNote')} ${LOCK_DURATION_MINUTES} ${t('minutesShortLabel')}.`);
        } else {
          setError(t('wrongEmailOrPassword'));
        }
        setToast({ message: t('loginFailed'), type: 'error' });
        setLoading(false);
        return;
      }

        // Přihlášení se povedlo - vynulujeme počítadlo špatných pokusů.
      callLockoutApi('reset', data.session?.access_token);

      let redirectTo: string | null = null;

      if (data.user) {
        // agreed_to_rules se z prohlížeče přímo nečte - je zavřený spolu
        // s ostatními údaji o účtu. Vydá ho funkce my_account(), a to jen
        // svému majiteli. Kdyby se tenhle sloupec nechal v selectu, celý
        // dotaz by skončil chybou a appka by při každém přihlášení
        // vyhodnotila profil jako neexistující - tedy pokus o založení
        // dalšího a odeslání na souhlas s pravidly dokola.
        const [{ data: existingProfile }, { data: accountRows }] = await Promise.all([
          supabase
            .from('profiles')
            .select('id, rating_mode, content_preference')
            .eq('id', data.user.id)
            .maybeSingle(),
          supabase.rpc('my_account'),
        ]);

        const account: any = Array.isArray(accountRows) ? accountRows[0] : accountRows;

        if (!existingProfile) {
          // Profil při registraci nevznikl (potvrzení e-mailu) - jméno z registrace, ne z e-mailu (lib/ensureProfile.ts).
          await ensureOwnProfile(supabase, data.user);
          redirectTo = '/welcome';
        } else if (!account?.agreed_to_rules || !existingProfile.rating_mode || !existingProfile.content_preference) {
          // Průvodce vítáním začne u prvního nevyplněného kroku (lib/welcome.ts).
          redirectTo = '/welcome';
        }
      }

      // ?next=/connect?… - odkud přihlášení přišlo (třeba připojení počítače
      // z appky Kine do PC). Jen relativní cesta v rámci Kine, nikam ven.
      const next = new URLSearchParams(window.location.search).get('next');
      const safeNext = next && /^\/(?!\/)[\w\-./?=&%+]*$/.test(next) ? next : null;

      setToast({ message: t('loginSuccess'), type: 'success' });
      setTimeout(() => {
        if (redirectTo) {
          router.push(redirectTo);
        } else if (safeNext) {
          router.push(safeNext);
        } else {
          router.push('/');
          router.refresh();
        }
      }, 900);
    } catch {
      // Cokoliv neočekávaného (výpadek sítě, appka mimo provoz...) appku
      // už nikdy nenechá "viset" na tlačítku - vždy se aspoň ukáže chyba.
      setError(t('twoFactorGenericError'));
      setLoading(false);
    }
  }

  return (
    <>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="signup auth-login">
        <AuthPitch title={t('loginPitchTitle')} />
        <form className="signup-form" onSubmit={handleLogin}>
          <h1>{t('login')}</h1>
          <p className="signup-hint auth-lead">{t('loginLead')}</p>
          <input type="email" placeholder={t('email')} aria-label={t('email')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <div className="signup-password">
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder={t('password')}
              aria-label={t('password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="signup-eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t('signupHidePassword') : t('signupShowPassword')}
              title={showPassword ? t('signupHidePassword') : t('signupShowPassword')}
            >
              <UiIcon name={showPassword ? 'lock' : 'eye'} size={16} />
            </button>
          </div>
          <Link href="/forgot-password" className="auth-forgot">
            {t('forgotPassword')}
          </Link>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <Turnstile ref={turnstile} action="login" onToken={setCaptchaToken} />
          <button type="submit" className="signup-submit" disabled={loading}>
            {loading ? t('signingIn') : t('login')}
          </button>
          <p className="signup-login">
            {t('noAccount')} <Link href="/signup">{t('signup')} →</Link>
          </p>
        </form>
      </div>
    </>
  );
}
