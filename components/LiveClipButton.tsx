'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/lib/i18n';
import { authHeaders } from '@/lib/authHeaders';
import UiIcon from './UiIcon';

type State = { kind: 'idle' } | { kind: 'saving' } | { kind: 'done'; clipId: string } | { kind: 'error'; text: string };

/**
 * „Klip“ u živého přenosu: jedním klikem uloží posledních ~30 s jako klip
 * (app/api/live/clip). Klip se pak pár vteřin zpracovává - odkaz vede na
 * jeho stránku, kde je vidět průběh.
 */
export default function LiveClipButton({ channelId, loggedIn }: { channelId: string; loggedIn: boolean }) {
  const { t, lang } = useLanguage();
  const [state, setState] = useState<State>({ kind: 'idle' });

  // Hláška po chvíli zmizí (odkaz na hotový klip vydrží déle).
  useEffect(() => {
    if (state.kind !== 'done' && state.kind !== 'error') return;
    const timer = setTimeout(() => setState({ kind: 'idle' }), state.kind === 'done' ? 20000 : 7000);
    return () => clearTimeout(timer);
  }, [state]);

  async function clip() {
    setState({ kind: 'saving' });
    try {
      const res = await fetch('/api/live/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ channel: channelId, lang }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.clipId) {
        setState({ kind: 'done', clipId: String(body.clipId) });
        return;
      }
      const code = body?.code;
      const text =
        code === 'too-early'
          ? t('liveClipTooEarly')
          : code === 'limit'
            ? t('liveClipLimit')
            : code === 'busy' || res.status === 429
              ? t('liveClipBusy')
              : code === 'not-live'
                ? t('liveClipNotLive')
                : code === 'blocked'
                  ? t('liveClipBlocked')
                  : t('liveClipFailed');
      setState({ kind: 'error', text });
    } catch {
      setState({ kind: 'error', text: t('liveClipFailed') });
    }
  }

  if (!loggedIn) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}`}
        className="live-clip-btn"
        title={t('liveClipTitle')}
      >
        <UiIcon name="scissors" size={15} />
        {t('liveClipButton')}
      </Link>
    );
  }

  return (
    <span className="live-clip">
      <button type="button" className="live-clip-btn" onClick={clip} disabled={state.kind === 'saving'} title={t('liveClipTitle')} aria-label={t('liveClipTitle')}>
        {state.kind === 'saving' ? <span className="spin" aria-hidden="true" /> : <UiIcon name="scissors" size={15} />}
        {state.kind === 'saving' ? t('liveClipSaving') : t('liveClipButton')}
      </button>
      {state.kind === 'done' && (
        <span className="live-clip-note ok" role="status">
          <UiIcon name="check" size={14} />
          {t('liveClipSaved')}{' '}
          <Link href={`/watch/${state.clipId}`} target="_blank" rel="noopener">
            {t('liveClipOpen')} →
          </Link>
        </span>
      )}
      {state.kind === 'error' && (
        <span className="live-clip-note error" role="alert">
          {state.text}
        </span>
      )}
    </span>
  );
}
