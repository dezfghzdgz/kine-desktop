'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useLanguage } from '@/lib/i18n';
import { GENRE_KEYS, gameBySlug, gameMonogram, relatedGames, videoMatchesGame } from '@/lib/games';
import { visibleNowFilter } from '@/lib/scheduling';
import { buildVideoBlocks } from '@/lib/videoBlocks';
import { useWatchProgress } from '@/lib/useWatchProgress';
import { useLiveList } from '@/lib/useLiveList';
import VideoCard from './VideoCard';
import { VideoBlockRow } from './SparksShelf';
import { LiveCard } from './LiveNowRow';
import GameFollowButton from './GameFollowButton';
import GameTile from './GameTile';
import UiIcon from './UiIcon';

type Tab = 'popular' | 'newest';

/** Co karta videa potřebuje (components/VideoCard.tsx) + hashtagy a kategorie kvůli pravidlu slabých hashtagů. */
const FIELDS =
  'id, title, thumbnail_url, views, duration_seconds, width, height, created_at, category, hashtags, owner_id, cloudflare_video_id, scheduled_at, is_premiere, profiles!videos_owner_id_fkey(id, username, created_at)';

/**
 * Stránka hry (/game/[slug]): kdo ji teď vysílá, videa a klipy z ní
 * (oblíbené / nejnovější), sledování hry a podobné hry. Videa se hledají
 * podle hashtagů hry (lib/games.ts) - klipy z appky Kine do PC je mají samy.
 */
export default function GameView({ slug }: { slug: string }) {
  const game = gameBySlug(slug)!;
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>('popular');
  const [videos, setVideos] = useState<any[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const live = useLiveList();
  const watchProgress = useWatchProgress((videos ?? []).map((v: any) => v.id));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15 * 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setVideos(null);
    setFailed(false);
    (async () => {
      let query = supabase
        .from('videos')
        .select(FIELDS)
        .eq('status', 'ready')
        .eq('visibility', 'public')
        .overlaps('hashtags', game.tags)
        .or(visibleNowFilter());
      query = tab === 'popular' ? query.order('views', { ascending: false }) : query.order('created_at', { ascending: false });
      const { data, error } = await query.limit(72);
      if (cancelled) return;
      if (error) {
        setFailed(true);
        setVideos([]);
        return;
      }
      // Slabé hashtagy (#rust, #mafia) jen v kategorii Hry - databáze to v jednom dotazu neumí.
      setVideos((data ?? []).filter((v: any) => videoMatchesGame(v, game)).slice(0, 48));
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, tab, game]);

  const liveHere = (live ?? []).filter((s) => s.game === slug && !s.hidden);
  const related = relatedGames(game, 10);
  const shownTags = [game.tag, ...game.strong.filter((x) => x !== game.tag)].slice(0, 4);

  return (
    <div className="game-page" style={{ '--game-color': game.color } as CSSProperties}>
      <header className="game-hero">
        <div className="game-hero-art" aria-hidden="true">
          <span className="game-hero-mono" data-len={gameMonogram(game).length}>
            {gameMonogram(game)}
          </span>
        </div>
        <div className="game-hero-body">
          <p className="game-hero-kicker">
            <Link href="/explore?category=catGaming">{t('catGaming')}</Link>
            <span aria-hidden="true"> · </span>
            {t(GENRE_KEYS[game.genre] as any)}
          </p>
          <h1 className="game-hero-title">{game.name}</h1>
          <p className="game-hero-tags">
            {shownTags.map((tag) => (
              <Link key={tag} href={`/hashtag/${tag}`}>
                #{tag}
              </Link>
            ))}
          </p>
          <div className="game-hero-actions">
            <GameFollowButton slug={slug} />
            <Link href={`/upload?game=${slug}`} className="game-hero-upload">
              <UiIcon name="upload" size={15} />
              {t('gameUploadCta')}
            </Link>
          </div>
        </div>
      </header>

      {liveHere.length > 0 && (
        <section className="game-section" aria-label={t('gamesLiveNow')}>
          <div className="live-now-head">
            <p className="section-title" style={{ margin: 0 }}>
              <span className="live-dot" aria-hidden="true" /> {t('gamesLiveNow')}
            </p>
            <Link href={`/streams?game=${slug}`} className="live-now-all">
              {t('liveNowSeeAll')} →
            </Link>
          </div>
          <div className="live-now-grid">
            {liveHere.slice(0, 8).map((s) => (
              <LiveCard key={s.ownerId} item={s} now={now} showGame={false} />
            ))}
          </div>
        </section>
      )}

      <div className="tab-row game-tabs" role="tablist">
        {(['popular', 'newest'] as Tab[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {t(key)}
          </button>
        ))}
      </div>

      {videos === null ? (
        <p style={{ color: 'var(--text-faint)' }}>{t('loading')}</p>
      ) : videos.length === 0 ? (
        <div className="game-empty panel">
          <span className="game-empty-icon" aria-hidden="true">
            <UiIcon name="gamepad" size={26} />
          </span>
          <p className="game-empty-title">{failed ? t('gameLoadFailed') : t('gameEmpty')}</p>
          {!failed && (
            <Link href={`/upload?game=${slug}`} className="game-hero-upload">
              <UiIcon name="upload" size={15} />
              {t('gameUploadCta')}
            </Link>
          )}
        </div>
      ) : (
        buildVideoBlocks(videos).map((block, bi) => (
          <VideoBlockRow key={bi} type={block.type} style={{ marginBottom: 20 }}>
            {block.items.map((video: any) => (
              <VideoCard
                key={video.id}
                video={video}
                href={block.type === 'sparks' ? `/sparks?start=${video.id}` : `/watch/${video.id}`}
                isSparks={block.type === 'sparks'}
                progressPercent={watchProgress[video.id]}
              />
            ))}
          </VideoBlockRow>
        ))
      )}

      <p className="game-clipper-note">
        <UiIcon name="scissors" size={14} />
        <span>{t('gameClipperNote')}</span>
        <Link href="/download">{t('desktopAppLink')} →</Link>
      </p>

      {related.length > 0 && (
        <section className="game-section">
          <p className="section-title">{t('gameRelated')}</p>
          <div className="game-row">
            {related.map((g) => (
              <GameTile key={g.slug} game={g} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
