'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/lib/i18n';
import { RAID_COUNTDOWN_S } from '@/lib/liveRaid';
import ProfileImage from './ProfileImage';
import UiIcon from './UiIcon';

export type LiveRaid = { at: string; to: { id: string; username: string | null; display_name: string | null; avatar_url: string | null } };

/**
 * Raid u přenosu (lib/liveRaid.ts): streamer poslal diváky k jinému kanálu.
 * Odpočet a pak přesun na jeho přenos; „Zůstat“ odpočet zastaví (pro tenhle
 * raid - další raid se zeptá znovu).
 */
export default function LiveRaidBanner({ raid, fromId, fromName }: { raid: LiveRaid; fromId: string; fromName: string }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [left, setLeft] = useState(RAID_COUNTDOWN_S);
  const [stayed, setStayed] = useState<string | null>(null);
  const target = raid.to.display_name || raid.to.username || '—';
  const href = `/live/${raid.to.id}?raid=${encodeURIComponent(fromId)}`;
  const active = stayed !== raid.at;

  useEffect(() => {
    setLeft(RAID_COUNTDOWN_S);
  }, [raid.at]);

  useEffect(() => {
    if (!active) return;
    if (left <= 0) {
      router.push(href);
      return;
    }
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [active, left, href, router]);

  if (!active) return null;
  return (
    <div className="live-raid-banner" role="status" aria-live="polite">
      <span className="live-raid-icon" aria-hidden="true">
        <UiIcon name="bolt" size={18} />
      </span>
      <span className="live-raid-avatar" aria-hidden="true">
        {raid.to.avatar_url ? <ProfileImage src={raid.to.avatar_url} /> : <span className="avatar-initial">{target.slice(0, 1).toUpperCase()}</span>}
      </span>
      <span className="live-raid-text">
        <span className="live-raid-title">{t('liveRaidBannerTitle').replace('{name}', fromName).replace('{target}', target)}</span>
        <span className="live-raid-sub">{t('liveRaidBannerCountdown').replace('{s}', String(Math.max(0, left)))}</span>
      </span>
      <span className="live-raid-actions">
        <button type="button" className="live-raid-go" onClick={() => router.push(href)}>
          {t('liveRaidGoNow')}
        </button>
        <button type="button" className="live-raid-stay" onClick={() => setStayed(raid.at)}>
          {t('liveRaidStay')}
        </button>
      </span>
      <span className="live-raid-progress" aria-hidden="true" style={{ width: `${(Math.max(0, left) / RAID_COUNTDOWN_S) * 100}%` }} />
    </div>
  );
}
