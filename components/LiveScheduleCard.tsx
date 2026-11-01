'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLanguage, DATE_LOCALES } from '@/lib/i18n';
import { authHeaders } from '@/lib/authHeaders';
import { calendarDaysUntil, countdownClock } from '@/lib/liveSchedule';
import { gameBySlug } from '@/lib/games';
import { supabase } from '@/lib/supabaseClient';
import GameChip from './GameChip';
import UiIcon from './UiIcon';

export type LiveSchedule = { startsAt: string; title: string; game?: string | null };

/** "za 2:14:05" / "za 3 dny" / "každou chvíli" - podle jazyka webu. */
export function useCountdown(startsAt: string): { text: string; soon: boolean } {
  const { t, lang } = useLanguage();
  const [now, setNow] = useState(() => Date.now());
  const left = Date.parse(startsAt) - now;
  const ticking = left > 0 && left < 24 * 3600 * 1000;
  useEffect(() => {
    // Pod den po vteřinách, jinak stačí jednou za minutu.
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : 60 * 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (!Number.isFinite(left) || left <= 0) return { text: t('liveScheduleSoon'), soon: true };
  const clock = countdownClock(left);
  if (clock) return { text: t('liveScheduleStartsIn').replace('{time}', clock), soon: false };
  const days = Math.max(1, calendarDaysUntil(Date.parse(startsAt), now));
  let relative = `${days} d`;
  try {
    relative = new Intl.RelativeTimeFormat(DATE_LOCALES[lang], { numeric: 'auto' }).format(days, 'day');
  } catch {
    /* starší prohlížeč - zůstane "3 d" */
  }
  return { text: relative.charAt(0).toUpperCase() + relative.slice(1), soon: false };
}

/** Den a čas začátku ("so 8. 11. 20:00") v jazyce webu. */
export function scheduleWhen(startsAt: string, lang: string): string {
  try {
    return new Date(startsAt).toLocaleString(DATE_LOCALES[lang as keyof typeof DATE_LOCALES], { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(startsAt).toLocaleString();
  }
}

/**
 * „Připomenout“: až kanál začne vysílat, přijde oznámení (i push).
 * initial = jestli už je zapnuté (null = nevíme - zjistí se samo).
 */
export function LiveRemindButton({
  channelId,
  initial = null,
  compact = false,
  autoLoad = true,
}: {
  channelId: string;
  initial?: boolean | null;
  compact?: boolean;
  /** false = stav zná rodič (seznam „Brzy živě“ se ptá naráz za všechny). */
  autoLoad?: boolean;
}) {
  const { t } = useLanguage();
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [on, setOn] = useState<boolean | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  useEffect(() => {
    if (initial !== null) setOn(initial);
  }, [initial]);

  useEffect(() => {
    if (!autoLoad || !userId || on !== null || userId === channelId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/live/schedule?channel=${encodeURIComponent(channelId)}`, { headers: await authHeaders(), cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok) setOn(!!body?.reminded);
      } catch {
        /* zůstane "Připomenout" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, on, channelId, autoLoad]);

  if (userId === channelId) return null;
  if (userId === null) {
    return (
      <Link href={`/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}`} className={`live-remind-btn${compact ? ' compact' : ''}`}>
        <UiIcon name="bell" size={15} />
        {t('liveScheduleRemind')}
      </Link>
    );
  }

  async function toggle() {
    setBusy(true);
    setError(null);
    const next = !on;
    try {
      const res = await fetch('/api/live/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ action: 'remind', channel: channelId, on: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.code === 'limit' ? t('liveScheduleRemindLimit') : t('liveScheduleRemindFailed'));
      setOn(!!body.reminded);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="live-remind">
      <button
        type="button"
        className={`live-remind-btn${on ? ' on' : ''}${compact ? ' compact' : ''}`}
        onClick={toggle}
        disabled={busy || userId === undefined}
        aria-pressed={!!on}
        title={t('liveScheduleRemindHint')}
      >
        <UiIcon name={on ? 'check' : 'bell'} size={15} />
        {on ? t('liveScheduleReminded') : t('liveScheduleRemind')}
      </button>
      {error && <span className="live-remind-error">{error}</span>}
    </span>
  );
}

/**
 * Plánované vysílání u kanálu / u offline přenosu: kdy, o čem, odpočet
 * a „Připomenout“ (majitel místo toho vidí, kolik lidí čeká).
 */
export default function LiveScheduleCard({ channelId, schedule, own = false, compact = false }: { channelId: string; schedule: LiveSchedule; own?: boolean; compact?: boolean }) {
  const { t, lang } = useLanguage();
  const countdown = useCountdown(schedule.startsAt);
  const game = gameBySlug(schedule.game);
  return (
    <div className={`live-schedule-card${compact ? ' compact' : ''}${countdown.soon ? ' soon' : ''}`}>
      <span className="live-schedule-icon" aria-hidden="true">
        <UiIcon name="calendar" size={compact ? 18 : 22} />
      </span>
      <span className="live-schedule-body">
        <span className="live-schedule-kicker">
          {t('liveScheduleKicker')} · {scheduleWhen(schedule.startsAt, lang)}
        </span>
        {schedule.title && <span className="live-schedule-title">{schedule.title}</span>}
        <span className="live-schedule-countdown" aria-live="off">
          {countdown.text}
        </span>
        {game && !compact && (
          <span className="live-schedule-game">
            <GameChip game={game} />
          </span>
        )}
      </span>
      <span className="live-schedule-action">
        {own ? (
          <Link href="/live" className="live-remind-btn compact">
            <UiIcon name="sliders" size={14} />
            {t('liveStudioTitle')}
          </Link>
        ) : (
          <LiveRemindButton channelId={channelId} compact={compact} />
        )}
      </span>
    </div>
  );
}
