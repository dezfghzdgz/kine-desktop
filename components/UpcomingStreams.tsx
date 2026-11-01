'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/lib/i18n';
import { gameBySlug } from '@/lib/games';
import { authHeaders } from '@/lib/authHeaders';
import ProfileImage from './ProfileImage';
import VerifiedBadge from './VerifiedBadge';
import UiIcon from './UiIcon';
import { LiveRemindButton, scheduleWhen, useCountdown } from './LiveScheduleCard';

type Upcoming = {
  ownerId: string;
  startsAt: string;
  title: string;
  game: string | null;
  profile: { id: string; username: string; displayName: string | null; avatarUrl: string | null; verificationTier: string | null };
};

function UpcomingCard({ item, reminded }: { item: Upcoming; reminded: boolean | null }) {
  const { t, lang } = useLanguage();
  const countdown = useCountdown(item.startsAt);
  const name = item.profile.displayName || item.profile.username;
  const game = gameBySlug(item.game);
  return (
    <li className={`upcoming-card${countdown.soon ? ' soon' : ''}`}>
      <Link href={`/channel/${item.ownerId}`} className="upcoming-card-link">
        <span className="upcoming-avatar" aria-hidden="true">
          {item.profile.avatarUrl ? <ProfileImage src={item.profile.avatarUrl} alt="" /> : <span className="avatar-initial">{name.slice(0, 1).toUpperCase()}</span>}
        </span>
        <span className="upcoming-text">
          <span className="upcoming-name">
            {name}
            <VerifiedBadge tier={item.profile.verificationTier as any} />
          </span>
          <span className="upcoming-title">{item.title || (game ? game.name : t('liveScheduleKicker'))}</span>
        </span>
      </Link>
      <div className="upcoming-foot">
        <span className="upcoming-when">
          <UiIcon name="calendar" size={13} /> {scheduleWhen(item.startsAt, lang)}
        </span>
        <span className="upcoming-countdown">{countdown.text}</span>
        <LiveRemindButton channelId={item.ownerId} compact initial={reminded} autoLoad={false} />
      </div>
    </li>
  );
}

/**
 * „Brzy živě“ na stránce Živě: nejbližší plánovaná vysílání (app/api/live/schedule?upcoming=1)
 * s odpočtem a „Připomenout“. Když nic naplánované není, nevykreslí nic.
 */
export default function UpcomingStreams() {
  const { t } = useLanguage();
  const [items, setItems] = useState<Upcoming[]>([]);
  // U kterých kanálů už mám připomenutí (jeden dotaz za celý seznam; nepřihlášený = null).
  const [mine, setMine] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/live/schedule?upcoming=1');
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok && Array.isArray(body?.upcoming)) setItems(body.upcoming);
      } catch {
        /* sekce prostě nebude */
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    (async () => {
      const headers = await authHeaders();
      if (!('Authorization' in headers)) return;
      try {
        const res = await fetch('/api/live/schedule?mine=1', { headers, cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok && Array.isArray(body?.reminders)) setMine(new Set(body.reminders as string[]));
      } catch {
        /* tlačítka zůstanou "Připomenout" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items.length]);

  if (items.length === 0) return null;
  return (
    <section className="upcoming-streams" aria-label={t('streamsUpcoming')}>
      <p className="section-title upcoming-head">
        <UiIcon name="calendar" size={18} /> {t('streamsUpcoming')}
      </p>
      <ul className="upcoming-list">
        {items.map((item) => (
          <UpcomingCard key={item.ownerId} item={item} reminded={mine ? mine.has(item.ownerId) : null} />
        ))}
      </ul>
    </section>
  );
}
