'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import KineLoader from '@/components/KineLoader';
import { supabase } from '@/lib/supabaseClient';
import { useLanguage, DATE_LOCALES } from '@/lib/i18n';
import { authHeaders, cacheableUrl } from '@/lib/authHeaders';
import { channelRoom, liveElapsed } from '@/lib/liveChat';
import { categoryLabel } from '@/lib/categories';
import { gameBySlug } from '@/lib/games';
import GameChip from '@/components/GameChip';
import LiveChat from '@/components/LiveChat';
import LiveTipDialog from '@/components/LiveTipDialog';
import SubscribeButton from '@/components/SubscribeButton';
import VerifiedBadge from '@/components/VerifiedBadge';
import ExpandableText from '@/components/ExpandableText';
import { FOLLOW_LIVE_MS, liveFrameUrl, preloadImage, setAmbientSource } from '@/lib/appearance';
import AmbientCanvas from '@/components/AmbientCanvas';
import { useAppearance } from '@/lib/useAppearance';
import ProfileImage from '@/components/ProfileImage';
import UiIcon from '@/components/UiIcon';
import LivePlayer from '@/components/LivePlayer';
import { nextPlayerUrl } from '@/lib/livePlayback';
import { CREATOR_PAYMENTS_ENABLED } from '@/lib/payments';
import LiveClipButton from '@/components/LiveClipButton';
import LiveRaidBanner, { type LiveRaid } from '@/components/LiveRaidBanner';
import LiveScheduleCard, { type LiveSchedule } from '@/components/LiveScheduleCard';

type Status = {
  enabled: boolean;
  live: boolean;
  /** Přenos skrytý automatickou kontrolou obsahu - divák místo přehrávače vidí "čeká na kontrolu". */
  held?: boolean;
  /** Jen pro majitele a tým Kine: skryté kontrolou obsahu / zablokovaný účet / shadow-ban (ostatní přenos nevidí, přehrávač s upozorněním). */
  moderation?: { hidden: boolean; restricted?: 'banned' | 'shadow-ban' | null; own?: boolean };
  /** Podpory ve vysílání (tlačítko 💛): kanál je umí přijmout. */
  tips?: { enabled: boolean; feePercent: number };
  /** Po vysílání: poslední zveřejněný záznam (kdo přišel pozdě, pustí si ho). */
  lastRecording?: { id: string; title: string; thumbnailUrl: string | null } | null;
  /** Kolik lidí se teď dívá (Cloudflare, server si číslo pamatuje 30 s); null = zatím nevíme. */
  viewers?: number | null;
  /** Mimo vysílání: plánované další (odpočet s „Připomenout“). Starší server ho neposílá. */
  schedule?: LiveSchedule | null;
  /** Raid: kanál poslal diváky jinam - po odpočtu se přesune (components/LiveRaidBanner.tsx). */
  raid?: LiveRaid | null;
  profile: { id: string; username: string; display_name: string | null; avatar_url: string | null; verification_tier: string | null } | null;
  stream: {
    title: string;
    description: string;
    category: string | null;
    /** Hra (lib/games.ts - slug); starší server ji neposílá. */
    game?: string | null;
    startedAt: string | null;
    endedAt: string | null;
    /** null = přehrávač zatím nejde (Cloudflare přenos ještě nepotvrdil). */
    playerUrl: string | null;
    videoUid: string | null;
    /** Od kdy ukazovat chat - každé vysílání má svůj (lib/liveChat.ts). Starší server ho neposílá. */
    chatSince?: string | null;
    /** Vlastní náhled přenosu (studio / appka). */
    thumbnailUrl?: string | null;
  } | null;
};

/**
 * Stránka živého přenosu kanálu: přehrávač Cloudflare (s vlastním
 * ovládáním - u živého vysílání umí i počet diváků), název, kanál a chat.
 * Stav se obnovuje každých 6 s: když přenos začne nebo skončí, stránka
 * se přepne sama.
 */
export default function LivePage() {
  const { t, lang } = useLanguage();
  const params = useParams();
  const channelId = params.id as string;
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Adresa přehrávače se drží, dokud přenos běží - změna src by iframe načetla znovu.
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  // Návrat z platby Stripe (?tip=thanks / ?tip=cancel).
  const [tipNotice, setTipNotice] = useState<'thanks' | 'cancel' | null>(null);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('tip');
    if (result === 'thanks' || result === 'cancel') {
      setTipNotice(result);
      window.history.replaceState(null, '', window.location.pathname);
      const timer = setTimeout(() => setTipNotice(null), 9000);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setViewerId(data.user?.id ?? null));
  }, []);

  // Přišel s raidem (?raid=<kanál>): krátké přivítání se jménem kanálu, odkud přišel - jen když ten
  // kanál opravdu právě poslal raid sem (odkaz s cizím ?raid= by jinak mohl "přivítat" čímkoli).
  const [raidFrom, setRaidFrom] = useState<string | null>(null);
  useEffect(() => {
    const from = new URLSearchParams(window.location.search).get('raid');
    if (!from || !/^[0-9a-f-]{36}$/i.test(from) || from.toLowerCase() === channelId.toLowerCase()) return;
    window.history.replaceState(null, '', window.location.pathname);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(cacheableUrl(`/api/live/status?channel=${encodeURIComponent(from)}`, {}), { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        const p = body?.profile as { username?: string | null; display_name?: string | null } | undefined;
        if (!cancelled && body?.raid?.to?.id?.toLowerCase() === channelId.toLowerCase() && p) setRaidFrom(p.display_name || p.username || null);
      } catch {
        /* bez přivítání */
      }
    })();
    const timer = setTimeout(() => setRaidFrom(null), 12000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [channelId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const headers = await authHeaders();
        const res = await fetch(cacheableUrl(`/api/live/status?channel=${encodeURIComponent(channelId)}`, headers), { cache: 'no-store', headers });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setStatus(body);
        // Adresa přehrávače se mění jen s novým přenosem (nové video) nebo když se z náhradní
        // stane adresa vstupu - stejná adresa iframe znovu nenačte (lib/livePlayback.ts).
        const incomingUrl = body.live ? body.stream?.playerUrl ?? null : null;
        if (incomingUrl) setPlayerUrl((current) => nextPlayerUrl(current, incomingUrl));
        if (!body.live) setPlayerUrl(null);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    load();
    const timer = setInterval(load, 6 * 1000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(tick);
    };
  }, [channelId]);

  const profile = status?.profile ?? null;
  const name = profile ? profile.display_name || profile.username : '';

  // Skleněný vzhled "podle videa" a světlo kolem přehrávače: snímek z přenosu (jinak avatar kanálu).
  // "Sleduje obraz" (Nastavení -> Vzhled): snímek z přenosu každé 2 s, barvy se plynule přelévají (AmbientCanvas).
  const appearance = useAppearance();
  const liveUid = status?.live ? status.stream?.videoUid ?? null : null;
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const followLive = appearance.follow && !!liveUid;
  useEffect(() => {
    setLiveFrame(null);
    if (!followLive || !liveUid) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const url = liveFrameUrl(liveUid, Date.now());
      if ((await preloadImage(url)) && !cancelled) setLiveFrame(url);
    };
    void tick();
    const timer = setInterval(() => void tick(), FOLLOW_LIVE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [followLive, liveUid]);
  const liveStill = liveUid ? `https://videodelivery.net/${encodeURIComponent(liveUid)}/thumbnails/thumbnail.jpg?height=270` : null;
  const ambientThumb = liveFrame ?? liveStill ?? profile?.avatar_url ?? null;
  useEffect(() => {
    setAmbientSource(ambientThumb);
  }, [ambientThumb]);
  useEffect(() => () => setAmbientSource(null), []);

  useEffect(() => {
    if (!status) return;
    const title = status.live ? `🔴 ${status.stream?.title || name}` : name;
    if (title) document.title = `${title} - Kine`;
  }, [status, name]);

  if (!status && !failed) return <p style={{ color: 'var(--text-faint)' }}>{t('loading')}</p>;
  if (!status || !profile) {
    return (
      <div className="auth-gate">
        <p>{t('liveNotAvailable')}</p>
      </div>
    );
  }
  if (!status.enabled) {
    return (
      <div className="auth-gate">
        <p>{t('liveNotAvailable')}</p>
        <Link href={`/channel/${profile.id}`}>{t('liveGoToChannel')}</Link>
      </div>
    );
  }

  const stream = status.stream;
  const liveGame = gameBySlug(stream?.game);
  const isOwner = viewerId === profile.id;
  // Každé vysílání má svůj chat: během vysílání zprávy od jeho začátku, po konci nový chat.
  const chatProps = {
    room: channelRoom(profile.id),
    canModerate: isOwner,
    className: 'live-side',
    popoutHref: `/live/${profile.id}/chat`,
    since: stream?.chatSince ?? null,
    note: !status.live && stream?.endedAt ? t('liveChatFreshOffline') : null,
  };

  const channelRow = (
    <div className="video-meta" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
      <Link href={`/channel/${profile.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="profile-avatar-small" style={{ width: 32, height: 32 }}>
          {profile.avatar_url ? <ProfileImage src={profile.avatar_url} alt={name} animate="always" /> : null}
        </span>
        <span>{name}</span>
        <VerifiedBadge tier={profile.verification_tier as any} />
      </Link>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {isOwner && (
          <Link href="/live" className="live-studio-link">
            {t('liveStudioTitle')}
          </Link>
        )}
        {status.live && !status.held && playerUrl && <LiveClipButton channelId={profile.id} loggedIn={!!viewerId} />}
        {!isOwner && status.live && status.tips?.enabled && CREATOR_PAYMENTS_ENABLED && (
          <button type="button" className="live-tip-btn" onClick={() => setTipOpen(true)}>
            💛 {t('tipButton')}
          </button>
        )}
        <SubscribeButton channelId={profile.id} />
      </div>
      {tipOpen && (
        <LiveTipDialog
          channelId={profile.id}
          channelName={name}
          feePercent={status.tips?.feePercent ?? 15}
          loggedIn={!!viewerId}
          onClose={() => setTipOpen(false)}
        />
      )}
    </div>
  );

  // Raid a přivítání po raidu - nahoře nad přehrávačem (i po konci vysílání).
  const raidBanner = status.raid && !isOwner ? <LiveRaidBanner raid={status.raid} fromId={profile.id} fromName={name} /> : null;
  const raidWelcome = raidFrom ? (
    <div className="live-raid-welcome" role="status">
      <UiIcon name="bolt" size={16} />
      <span>{t('liveRaidArrived').replace('{name}', raidFrom)}</span>
    </div>
  ) : null;

  if (status.live && status.held) {
    return (
      <div className="live-layout">
        <div className="live-main">
          <div className="live-held" role="status">
            <div>
              <p style={{ fontSize: 28, margin: 0 }} aria-hidden="true">
                ⏸
              </p>
              <p style={{ fontWeight: 700, color: 'var(--text)', fontSize: 'var(--fs-lg)' }}>{t('liveHeldTitle')}</p>
              <p>{t('liveHeldText')}</p>
            </div>
          </div>
          {channelRow}
        </div>
        <LiveChat {...chatProps} />
      </div>
    );
  }

  if (status.live && !playerUrl) {
    // Appka hlásí vysílání, Cloudflare ho ale ještě nepotvrdil - přehrávač by ukázal jen
    // stojící obrázek. Stránka se ptá každých 6 s a přehrávač ukáže, jakmile to jde.
    return (
      <div className="live-layout">
        <div className="live-main">
          {raidBanner}
          {raidWelcome}
          <div className="player-wrap live-player live-connecting" style={{ aspectRatio: '16/9' }} role="status">
            <KineLoader />
            <p>{t('liveConnecting')}</p>
          </div>
          <h1 className="video-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="live-pill">● {t('liveBadge')}</span>
            {stream?.title || name}
          </h1>
          {channelRow}
        </div>
        <LiveChat {...chatProps} />
      </div>
    );
  }

  if (!status.live || !playerUrl) {
    return (
      <div className="live-layout">
        <div className="live-main">
          {raidBanner}
          {status.schedule && <LiveScheduleCard channelId={profile.id} schedule={status.schedule} own={isOwner} />}
          <div className="live-offline panel">
            <p className="live-offline-title">{t('liveOfflineTitle').replace('{name}', name)}</p>
            {stream?.endedAt && (
              <p className="live-offline-note">
                {t('liveOfflineEnded').replace('{time}', new Date(stream.endedAt).toLocaleString(DATE_LOCALES[lang]))}
              </p>
            )}
            {status.lastRecording && (
              <Link href={`/watch/${status.lastRecording.id}`} className="live-offline-recording">
                {status.lastRecording.thumbnailUrl ? <img src={status.lastRecording.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : null}
                <span>
                  <span className="live-offline-recording-label">{t('liveOfflineRecording')}</span>
                  <span className="live-offline-recording-title">{status.lastRecording.title}</span>
                </span>
              </Link>
            )}
            <Link href={`/channel/${profile.id}`}>{t('liveGoToChannel')} →</Link>
          </div>
          {channelRow}
        </div>
        <LiveChat {...chatProps} />
      </div>
    );
  }

  return (
    <div className="live-layout">
      <div className="live-main">
        {raidBanner}
        {raidWelcome}
        {status.moderation?.hidden && (
          <div className="moderation-hold-note" role="status">
            <UiIcon name="warning" size={18} />
            {/* Majiteli "tvůj přenos", týmu Kine co se děje a kde ho pustit. */}
            <span>{status.moderation.own === false ? t('liveHeldStaff') : t('liveHeldOwner')}</span>
          </div>
        )}
        {status.moderation?.restricted && (
          <div className="moderation-hold-note" role="status">
            <UiIcon name="warning" size={18} />
            <span>{status.moderation.restricted === 'banned' ? t('liveRestrictedBannedNote') : t('liveRestrictedShadowNote')}</span>
          </div>
        )}
        {tipNotice && (
          <div className={`tip-notice ${tipNotice}`} role="status">
            {tipNotice === 'thanks' ? `💛 ${t('tipThanks')}` : t('tipCancelled')}
          </div>
        )}
        <div className="live-player-ambient-host" style={{ position: 'relative' }}>
          <LivePlayer url={playerUrl} title={stream?.title || name} />
          {liveUid && (
            <div className="player-ambient" aria-hidden="true">
              <AmbientCanvas src={liveFrame ?? liveStill} />
            </div>
          )}
        </div>
        <h1 className="video-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="live-pill">● {t('liveBadge')}</span>
          {stream?.title || name}
        </h1>
        <p className="live-meta">
          {typeof status.viewers === 'number' && (
            <span className="live-meta-viewers" title={t('liveViewersNow')}>
              <UiIcon name="eye" size={14} /> {new Intl.NumberFormat(DATE_LOCALES[lang]).format(status.viewers)}
              <span className="live-stats-sr"> {t('liveViewersNow')}</span>
              {' · '}
            </span>
          )}
          {stream?.startedAt && <span>{liveElapsed(stream.startedAt, now)}</span>}
          {stream?.category && !liveGame && <span> · {categoryLabel(stream.category, t)}</span>}
        </p>
        {liveGame && (
          <p className="live-game-row">
            <GameChip game={liveGame} />
          </p>
        )}
        {channelRow}
        {stream?.description && (
          <div className="panel" style={{ marginTop: 14 }}>
            <ExpandableText text={stream.description} />
          </div>
        )}
      </div>
      <LiveChat {...chatProps} />
    </div>
  );
}
