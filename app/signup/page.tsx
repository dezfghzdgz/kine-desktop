'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Toast, { ToastType } from '@/components/Toast';
import { useLanguage } from '@/lib/i18n';
import AuthPitch from '@/components/AuthPitch';
import Turnstile, { TURNSTILE_SITE_KEY, isCaptchaError, type TurnstileHandle } from '@/components/Turnstile';
import { validateUsername } from '@/lib/username';
import UiIcon from '@/components/UiIcon';

/** "%" a "_" jsou v ILIKE zástupné znaky - jméno se porovnává doslova (bez ohledu na velikost písmen, jako v databázi). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export default function SignupPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  /** Je jméno volné? null = nevíme (prázdné, neplatné, ještě se ptáme). */
  const [nameFree, setNameFree] = useState<boolean | null>(null);
  /** Supabase chce potvrdit e-mail (Confirm email) - kam odešel odkaz. */
  const [confirmSentTo, setConfirmSentTo] = useState<string | null>(null);

  // Volné jméno se ověří hned při psaní (s malou prodlevou), ne až po odeslání.
  useEffect(() => {
    setNameFree(null);
    const name = username.trim();
    if (!name || validateUsername(name)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { count, error: lookupError } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .ilike('username', escapeLike(name));
      // Bez čísla (síť, cizí odpověď) se nic netvrdí - rozhodne databáze při registraci.
      if (!cancelled && !lookupError && typeof count === 'number') setNameFree(count === 0);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [username]);

  const usernameProblem = username.trim() ? validateUsername(username) : null;

  // Ochrana proti botům (components/Turnstile.tsx) - token na jeden pokus.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== passwordConfirm) {
      setError(t('passwordsDontMatch'));
      setToast({ message: t('signupFailed'), type: 'error' });
      return;
    }

    // Jméno se kontroluje ještě před založením účtu - jinak by v Supabase
    // vznikl přihlašovací účet, ke kterému se profil nedá dopsat.
    // Skutečnou stráží je stejně databáze (supabase-migration-username-rules.sql),
    // tohle je jen proto, aby se chyba dala přečíst.
    const usernameProblem = validateUsername(username);
    if (usernameProblem) {
      setError(t(usernameProblem));
      setToast({ message: t('signupFailed'), type: 'error' });
      return;
    }

    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError(t('captchaWait'));
      return;
    }

    setLoading(true);

    const { data, error: signupError } = await supabase.auth.signUp({
      email,
      password,
      // Vybrané jméno zůstane u účtu - se zapnutým potvrzením e-mailu profil
      // vznikne až po kliknutí na odkaz (lib/ensureProfile.ts).
      options: { data: { username: username.trim() }, ...(captchaToken ? { captchaToken } : {}) },
    });
    turnstile.current?.reset();

    if (signupError) {
      setError(isCaptchaError(signupError.message) ? t('captchaFailed') : signupError.message);
      setToast({ message: t('signupFailed'), type: 'error' });
      setLoading(false);
      return;
    }

    if (data.session) {
      const { error: profileError } = await supabase.from('profiles').insert({
        id: data.user!.id,
        username: username.trim(),
        display_name: username.trim(),
      });

      if (profileError) {
        console.warn('Kine: profil po registraci se nezaložil -', profileError.message);
        setError(t('signupProfileFailed'));
        setToast({ message: t('signupFailed'), type: 'error' });
        setLoading(false);
        return;
      }

      await supabase.from('playlists').insert({
        owner_id: data.user!.id,
        title: 'Sledovat později',
        color: '#3a5a8a',
        is_system: true,
      });

      setToast({ message: t('signupSuccess'), type: 'success' });
      setTimeout(() => router.push('/welcome'), 900);
      return;
    }

    // Bez přihlášení = Supabase chce nejdřív potvrdit e-mail. Profil vznikne po kliknutí
    // na odkaz (lib/ensureProfile.ts) - tady jen srozumitelně říct, co dál.
    setLoading(false);
    setConfirmSentTo(email.trim());
  }

  return (
    <>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="signup">
        {/* Co Kine je - aby registrace nebyla jen formulář bez kontextu. */}
        <AuthPitch />

        {confirmSentTo ? (
          <div className="signup-form" role="status">
            <h1>{t('signupCheckEmailTitle')}</h1>
            <p className="signup-hint" style={{ fontSize: 15, lineHeight: 1.6 }}>{t('signupCheckEmailText').replace('{email}', confirmSentTo)}</p>
            <p className="signup-login">
              <Link href="/login">{t('loginLink')}</Link>
            </p>
          </div>
        ) : (
        <form className="signup-form" onSubmit={handleSignup}>
          <h1>{t('createAccount')}</h1>
          <div>
            <input
              type="text"
              placeholder={t('username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              aria-invalid={!!usernameProblem || nameFree === false}
              required
            />
            <p className={`signup-hint ${usernameProblem || nameFree === false ? 'bad' : nameFree ? 'good' : ''}`}>
              {usernameProblem ? t(usernameProblem) : nameFree === false ? t('signupNameTaken') : nameFree ? t('signupNameFree') : t('usernameHint')}
            </p>
          </div>
          <div>
            <input type="email" placeholder={t('email')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <p className="signup-hint">{t('emailHint')}</p>
          </div>
          <div>
            <div className="signup-password">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder={t('password') + ' (min. 6)'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                autoComplete="new-password"
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
            <p className="signup-hint">{t('passwordHint')}</p>
          </div>
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder={t('repeatPassword')}
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            minLength={6}
            autoComplete="new-password"
            required
          />
          <label className="signup-agree">
            <input type="checkbox" required />
            <span>
              {t('agreeToTerms')} <a href="/terms" target="_blank">{t('termsOfService')}</a> {t('and')} <a href="/privacy" target="_blank">{t('privacyPolicy')}</a>.
            </span>
          </label>
          {error && <p className="error-text">{error}</p>}
          <Turnstile ref={turnstile} action="signup" onToken={setCaptchaToken} />
          <button type="submit" className="signup-submit" disabled={loading || nameFree === false}>
            {loading ? t('creatingAccount') : t('signUpButton')}
          </button>
          <p className="signup-login">
            {t('haveAccount')} <Link href="/login">{t('loginLink')}</Link>
          </p>
        </form>
        )}
      </div>
    </>
  );
}
