'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '@/lib/i18n';
import { PanelHeading } from './HelpTip';
import UiIcon from './UiIcon';
import { scheduleWhen, useCountdown, type LiveSchedule } from './LiveScheduleCard';

/** Datum pro <input type="datetime-local"> v místním čase ("2026-11-08T20:00"). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Výchozí čas: příští celá hodina, aspoň za 30 minut. */
function defaultStart(): string {
  const d = new Date(Date.now() + 30 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d.getTime());
}

function Countdown({ startsAt }: { startsAt: string }) {
  const c = useCountdown(startsAt);
  return <span className="live-schedule-countdown">{c.text}</span>;
}

/**
 * Studio: plánované vysílání (app/api/live/schedule). Kdy začneš a o čem -
 * na kanálu a u přenosu se ukáže odpočet s „Připomenout“.
 */
export default function LiveSchedulePanel({
  token,
  userId,
  defaultTitle,
  game,
  onToast,
}: {
  token: string;
  userId: string;
  defaultTitle: string;
  game: string | null;
  onToast: (message: string, type: 'success' | 'error') => void;
}) {
  const { t, lang } = useLanguage();
  const [schedule, setSchedule] = useState<LiveSchedule | null>(null);
  const [reminders, setReminders] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(defaultStart);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/live/schedule?channel=${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (cancelled || !res.ok || !body) return;
        setSchedule(body.schedule ?? null);
        setReminders(typeof body.reminders === 'number' ? body.reminders : null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, token]);

  function startEditing() {
    setWhen(schedule ? toLocalInput(Date.parse(schedule.startsAt)) : defaultStart());
    setTitle(schedule?.title ?? defaultTitle);
    setEditing(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const at = new Date(when);
    if (!Number.isFinite(at.getTime())) return;
    setBusy(true);
    try {
      const res = await fetch('/api/live/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'set', startsAt: at.toISOString(), title, game }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const text = body?.code === 'time-past' ? t('liveScheduleErrPast') : body?.code === 'time-far' ? t('liveScheduleErrFar') : body?.error ?? t('liveScheduleErrSave');
        throw new Error(text);
      }
      setSchedule(body.schedule ?? null);
      setEditing(false);
      onToast(t('liveScheduleSaved'), 'success');
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const res = await fetch('/api/live/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'clear' }),
      });
      if (!res.ok) throw new Error(t('liveScheduleErrSave'));
      setSchedule(null);
      setEditing(false);
      onToast(t('liveScheduleRemoved'), 'success');
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel live-schedule-panel">
      <PanelHeading icon="calendar" title={t('liveScheduleHeading')} help={t('liveScheduleHelp')} />
      {!loaded ? (
        <p className="live-hint">{t('loading')}</p>
      ) : editing ? (
        <form className="live-schedule-form" onSubmit={save}>
          <label className="live-field">
            <span>{t('liveScheduleWhen')}</span>
            <input type="datetime-local" value={when} min={toLocalInput(Date.now() + 60 * 1000)} onChange={(e) => setWhen(e.target.value)} required />
          </label>
          <label className="live-field">
            <span>{t('liveScheduleTitleLabel')}</span>
            <input type="text" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="live-schedule-buttons">
            <button type="submit" disabled={busy || !when}>
              {t('liveScheduleSave')}
            </button>
            <button type="button" className="live-small-btn" onClick={() => setEditing(false)} disabled={busy}>
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : schedule ? (
        <div className="live-schedule-current">
          <div className="live-schedule-current-text">
            <span className="live-schedule-when">
              <UiIcon name="calendar" size={14} /> {scheduleWhen(schedule.startsAt, lang)}
            </span>
            {schedule.title && <span className="live-schedule-title">{schedule.title}</span>}
            <Countdown startsAt={schedule.startsAt} />
            {reminders !== null && (
              <span className="live-hint" style={{ margin: 0 }}>
                <UiIcon name="bell" size={13} /> {t('liveScheduleRemindersCount').replace('{n}', String(reminders))}
              </span>
            )}
          </div>
          <div className="live-schedule-buttons">
            <button type="button" className="live-small-btn" onClick={startEditing} disabled={busy}>
              {t('liveScheduleEdit')}
            </button>
            <button type="button" className="live-small-btn live-danger" onClick={clear} disabled={busy}>
              {t('liveScheduleRemove')}
            </button>
          </div>
        </div>
      ) : (
        <div className="live-schedule-empty">
          <p className="live-hint" style={{ margin: 0 }}>{t('liveScheduleNone')}</p>
          <button type="button" onClick={startEditing}>
            <UiIcon name="calendar" size={15} /> {t('liveScheduleSave')}
          </button>
        </div>
      )}
    </div>
  );
}
