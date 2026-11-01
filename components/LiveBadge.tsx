'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/lib/i18n';
import { authHeaders, cacheableUrl } from '@/lib/authHeaders';
import LiveScheduleCard, { type LiveSchedule } from './LiveScheduleCard';

/**
 * "● ŽIVĚ" u kanálu, který právě vysílá (odkaz na stránku přenosu).
 * Když nevysílá, ale má naplánované vysílání, ukáže odpočet s „Připomenout“
 * (withTitle - na kanálu). Jinak nevykreslí nic.
 */
export default function LiveBadge({ channelId, withTitle = false }: { channelId: string; withTitle?: boolean }) {
  const { t } = useLanguage();
  const [live, setLive] = useState<{ title: string } | null>(null);
  const [schedule, setSchedule] = useState<LiveSchedule | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // S přihlášením: majitel shadow-banovaného kanálu svůj přenos vidí (ostatní ne).
        const headers = await authHeaders();
        const res = await fetch(cacheableUrl(`/api/live/status?channel=${encodeURIComponent(channelId)}`, headers), { cache: 'no-store', headers });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        setLive(body?.live ? { title: body.stream?.title ?? '' } : null);
        setSchedule(!body?.live && body?.schedule?.startsAt ? body.schedule : null);
      } catch {
        if (!cancelled) setLive(null);
      }
    }
    load();
    // Jen když je karta vidět (stav přenosu se ptá Cloudflare); po návratu hned.
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 30 * 1000);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [channelId]);

  if (!live) return schedule && withTitle ? <LiveScheduleCard channelId={channelId} schedule={schedule} compact /> : null;
  return (
    <Link href={`/live/${channelId}`} className="live-banner">
      <span className="live-pill">● {t('liveBadge')}</span>
      {withTitle && <span className="live-banner-title">{live.title || t('liveNowBanner')}</span>}
      <span className="live-banner-action">{t('liveWatchButton')} →</span>
    </Link>
  );
}
