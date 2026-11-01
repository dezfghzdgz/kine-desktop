'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '@/lib/i18n';
import { authHeaders } from '@/lib/authHeaders';
import { POLL_DEFAULT_S, POLL_DURATIONS_S, POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, POLL_RESULTS_SHOW_MS, type PollSummary } from '@/lib/livePolls';
import UiIcon from './UiIcon';

type Poll = PollSummary & { room: string };

const VOTE_KEY = (id: string) => `kine-live-poll:${id}`;

function readVote(id: string): number | null {
  try {
    const raw = localStorage.getItem(VOTE_KEY(id));
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function saveVote(id: string, choice: number): void {
  try {
    localStorage.setItem(VOTE_KEY(id), String(choice));
  } catch {
    /* soukromé okno - hlas si zapamatuje server */
  }
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Anketa v chatu živého vysílání (lib/livePolls.ts, app/api/live/poll).
 *
 * Chat ví o nové anketě ze zprávy druhu 'poll' (pollHint = její id) a po
 * otevření se zeptá sám. Během ankety se ptá na hlasy každé ~3 s, po konci
 * ještě chvíli ukazuje výsledky. Streamer a moderátoři ji tu zakládají
 * (composerOpen) a můžou ji ukončit dřív. Překryv pro OBS jen ukazuje.
 */
export default function LivePollBox({
  room,
  canManage,
  loggedIn,
  pollHint,
  overlay = false,
  composerOpen = false,
  onComposerClose,
}: {
  room: string;
  canManage: boolean;
  loggedIn: boolean;
  pollHint: string | null;
  overlay?: boolean;
  composerOpen?: boolean;
  onComposerClose?: () => void;
}) {
  const { t } = useLanguage();
  const [poll, setPoll] = useState<Poll | null>(null);
  const [myVote, setMyVote] = useState<number | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endedSeenRef = useRef<{ id: string; at: number } | null>(null);
  // Formulář nové ankety.
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [seconds, setSeconds] = useState<number>(POLL_DEFAULT_S);

  async function load(query: string): Promise<void> {
    try {
      const res = await fetch(`/api/live/poll?${query}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (res.ok && body) setPoll(body.poll ?? null);
    } catch {
      /* další pokus při příští obnově */
    }
  }

  // Po otevření chatu: běží anketa?
  useEffect(() => {
    setPoll(null);
    void load(`room=${encodeURIComponent(room)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // Nová anketa ohlášená v chatu.
  useEffect(() => {
    if (pollHint && pollHint !== poll?.id) void load(`id=${encodeURIComponent(pollHint)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollHint]);

  useEffect(() => {
    if (poll) setMyVote(readVote(poll.id));
  }, [poll?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Během ankety hlasy každé ~3 s (jen když je karta vidět; překryv v OBS vždy) a odpočet po vteřinách.
  const active = !!poll?.active && Date.parse(poll.endsAt) > now;
  useEffect(() => {
    if (!poll || !poll.active) return;
    const id = poll.id;
    const refresh = setInterval(() => {
      if (overlay || document.visibilityState === 'visible') void load(`id=${encodeURIComponent(id)}`);
    }, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(refresh);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll?.id, poll?.active, overlay]);

  // Odpočet doběhl: ještě jednou pro konečné výsledky.
  useEffect(() => {
    if (poll && poll.active && !active) void load(`id=${encodeURIComponent(poll.id)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Skončená anketa se po chvíli schová sama.
  useEffect(() => {
    if (!poll || poll.active) return;
    if (endedSeenRef.current?.id !== poll.id) endedSeenRef.current = { id: poll.id, at: Date.now() };
    const left = POLL_RESULTS_SHOW_MS - (Date.now() - endedSeenRef.current.at);
    const timer = setTimeout(() => setHidden(poll.id), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [poll]);

  async function post(payload: Record<string, unknown>): Promise<any> {
    const res = await fetch('/api/live/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  async function vote(choice: number) {
    if (!poll || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { ok, body } = await post({ action: 'vote', id: poll.id, choice });
      if (body?.poll) setPoll(body.poll);
      if (ok) {
        const mine = typeof body.choice === 'number' ? body.choice : choice;
        setMyVote(mine);
        saveVote(poll.id, mine);
      } else {
        setError(body?.code === 'ended' ? t('pollEnded') : body?.code === 'banned' ? t('livePollBanned') : t('livePollVoteFailed'));
      }
    } catch {
      setError(t('livePollVoteFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!poll) return;
    setBusy(true);
    try {
      const { body } = await post({ action: 'end', id: poll.id });
      if (body?.poll) setPoll(body.poll);
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ok, body } = await post({ action: 'create', room, question, options, seconds });
      if (!ok) {
        const code = body?.code;
        setError(code === 'question' ? t('livePollErrQuestion') : code === 'options' ? t('livePollErrOptions') : code === 'duplicate' ? t('livePollErrDuplicate') : body?.error ?? t('livePollErrCreate'));
        return;
      }
      setPoll(body.poll);
      setHidden(null);
      setQuestion('');
      setOptions(['', '']);
      onComposerClose?.();
    } catch {
      setError(t('livePollErrCreate'));
    } finally {
      setBusy(false);
    }
  }

  const composer = composerOpen && canManage && !overlay && (
    <form className="live-poll live-poll-composer" onSubmit={create}>
      <div className="live-poll-head">
        <UiIcon name="poll" size={15} />
        <span className="live-poll-label">{t('livePollNew')}</span>
        <button type="button" className="live-chat-icon-btn" onClick={onComposerClose} aria-label={t('cancel')} title={t('cancel')}>
          ✕
        </button>
      </div>
      <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={POLL_QUESTION_MAX} placeholder={t('livePollQuestion')} aria-label={t('livePollQuestion')} autoFocus />
      {options.map((opt, i) => (
        <div key={i} className="live-poll-option-row">
          <input
            type="text"
            value={opt}
            onChange={(e) => setOptions((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
            maxLength={POLL_OPTION_MAX}
            placeholder={t('livePollOption').replace('{n}', String(i + 1))}
            aria-label={t('livePollOption').replace('{n}', String(i + 1))}
          />
          {options.length > 2 && (
            <button type="button" className="live-chat-icon-btn" onClick={() => setOptions((list) => list.filter((_, j) => j !== i))} aria-label={t('livePollRemoveOption')} title={t('livePollRemoveOption')}>
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="live-poll-composer-row">
        {options.length < POLL_MAX_OPTIONS && (
          <button type="button" className="live-small-btn" onClick={() => setOptions((list) => [...list, ''])}>
            <UiIcon name="plus" size={13} /> {t('livePollAddOption')}
          </button>
        )}
        <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} aria-label={t('livePollDuration')}>
          {POLL_DURATIONS_S.map((s) => (
            <option key={s} value={s}>
              {s < 60 ? t('liveChatSeconds').replace('{n}', String(s)) : t('liveChatMinutes').replace('{n}', String(s / 60))}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || !question.trim() || options.filter((o) => o.trim()).length < 2}>
          {t('livePollStart')}
        </button>
      </div>
      {error && <p className="live-chat-error" style={{ margin: 0 }}>{error}</p>}
    </form>
  );

  if (!poll || hidden === poll.id) return composer || null;

  const showResults = !active || myVote !== null || canManage || !loggedIn || overlay;
  const canVote = active && loggedIn && myVote === null && !overlay;

  return (
    <>
      {composer}
      <div className={`live-poll${overlay ? ' overlay' : ''}${active ? ' active' : ' ended'}`} role="group" aria-label={t('livePollHeading')}>
        <div className="live-poll-head">
          <UiIcon name="poll" size={15} />
          <span className="live-poll-label">{t('livePollHeading')}</span>
          <span className="live-poll-timer">{active ? t('livePollEndsIn').replace('{time}', clock(Date.parse(poll.endsAt) - now)) : t('pollEnded')}</span>
          {canManage && active && !overlay && (
            <button type="button" className="live-small-btn" onClick={end} disabled={busy}>
              {t('livePollEnd')}
            </button>
          )}
          {!overlay && (
            <button type="button" className="live-chat-icon-btn" onClick={() => setHidden(poll.id)} aria-label={t('livePollHide')} title={t('livePollHide')}>
              ✕
            </button>
          )}
        </div>
        <p className="live-poll-question">{poll.question}</p>
        <div className="post-poll live-poll-options">
          {poll.options.map((text, i) => {
            const mine = myVote === i;
            return (
              <button
                key={i}
                type="button"
                className={`post-poll-option${mine ? ' mine' : ''}${poll.winner === i ? ' winner' : ''}`}
                onClick={() => vote(i)}
                disabled={!canVote || busy}
                aria-pressed={mine}
              >
                {showResults && <span className="post-poll-bar" style={{ width: `${poll.percents[i] ?? 0}%` }} aria-hidden="true" />}
                <span className="post-poll-label">
                  {mine && <UiIcon name="check" size={14} />}
                  {poll.winner === i && <UiIcon name="trophy" size={14} />}
                  {text}
                </span>
                {showResults && <span className="post-poll-percent">{poll.percents[i] ?? 0} %</span>}
              </button>
            );
          })}
        </div>
        <p className="post-poll-meta">
          {t('pollVotes').replace('{n}', String(poll.total))}
          {active && !loggedIn && !overlay ? ` · ${t('livePollSignIn')}` : ''}
        </p>
        {error && !composerOpen && <p className="live-chat-error" style={{ margin: 0 }}>{error}</p>}
      </div>
    </>
  );
}
