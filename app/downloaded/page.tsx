'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/lib/i18n';
import { useSearchParams } from 'next/navigation';
import { filterBySearch } from '@/lib/searchScope';
import ScopedSearchEmpty from '@/components/ScopedSearchEmpty';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { fetchAllRows, fetchByIds } from '@/lib/loadAll';
import VideoCard from '@/components/VideoCard';
import { formatDuration } from '@/lib/homeRecommendation';
import { isMusicVideo } from '@/lib/playbackMode';
import { useMusicCommands } from '@/lib/musicPlayer';
import type { MusicTrack } from '@/lib/musicPlayer';
import { trackFromVideo } from '@/lib/musicQueue';
import { PlayIcon } from '@/components/MusicIcons';
import DownloadButton from '@/components/DownloadButton';
import LoadFailed from '@/components/LoadFailed';
import EmptyState from '@/components/EmptyState';

type Filter = 'all' | 'music' | 'video';

function DownloadedPageInner() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const query = searchParams.get('q')?.toLowerCase() ?? '';
  // Hledání v knihovně (pole nahoře) - lib/searchScope.ts; původní text pro hlášku „nic tu není“.
  const rawQuery = searchParams.get('q') ?? '';
  const [videos, setVideos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Dotaz může spadnout (vypadlá síť, propadlé přihlášení). Bez tohohle
  // stránka tvrdila, že seznam je prázdný.
  const [loadFailed, setLoadFailed] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const musicCommands = useMusicCommands();

  useEffect(() => {
    startLoad();
  }, []);

  /**
   * Načtení seznamu tak, aby se dalo poznat, že se nepovedlo.
   *
   * fetchAllRows/fetchByIds odteď chybu vyhodí místo toho, aby vrátily
   * prázdno - jinak se výpadek sítě tvářil úplně stejně jako prázdný
   * seznam a stránka napsala "zatím tu nic není" i tomu, kdo tu má sto
   * položek.
   */
  async function startLoad() {
    setLoading(true);
    setLoadFailed(false);
    try {
      await load();
    } catch {
      setLoadFailed(true);
      setLoading(false);
    }
  }

  async function load() {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      setLoading(false);
      return;
    }
    setUserId(authData.user.id);

    const downloads = await fetchAllRows((from, to) =>
      supabase
        .from('downloads')
        .select('video_id, downloaded_at')
        .eq('user_id', authData.user!.id)
        .order('downloaded_at', { ascending: false })
        .range(from, to)
    );

    const videoIds = downloads.map((d: any) => d.video_id);

    if (videoIds.length > 0) {
      // Kategorie a rozměry jsou tu kvůli tomu, aby appka poznala hudbu od
      // videa. cloudflare_video_id kvůli přehrávání a náhledu při najetí -
      // bez něj karta obojí tiše vynechá.
      const ordered = await fetchByIds<any>(
        'videos',
        'id, title, thumbnail_url, views, duration_seconds, width, height, category, cloudflare_video_id, owner_id, profiles!videos_owner_id_fkey(id, username)',
        videoIds
      );
      setVideos(ordered);
    }

    setLoading(false);
  }

  const musicVideos = useMemo(() => videos.filter(isMusicVideo), [videos]);
  const otherVideos = useMemo(() => videos.filter((v) => !isMusicVideo(v)), [videos]);

  const shown = useMemo(() => {
    const base = filter === 'music' ? musicVideos : filter === 'video' ? otherVideos : videos;
    return filterBySearch(base, query);
  }, [filter, videos, musicVideos, otherVideos, query]);

  /**
   * Pustí všechnu staženou hudbu za sebou.
   *
   * Přesně kvůli tomuhle to tu je: mezi staženými se míchá hudba s videi
   * a při poslouchání do toho videa nemají co mluvit.
   */
  function playAllMusic() {
    const tracks = musicVideos
      .map(trackFromVideo)
      .filter((track): track is MusicTrack => track !== null);

    if (tracks.length === 0) return;
    musicCommands.openTrack(tracks[0], tracks);
  }

  if (loadFailed) return <LoadFailed onRetry={startLoad} />;
  if (loading) return <p style={{ color: 'var(--text-faint)' }}>{t('loading')}</p>;

  if (!userId) {
    return (
      <div className="auth-gate">
        <p>{t('loginToViewDownloadedNote')}</p>
        <Link href="/login">{t('loginLink')}</Link>
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <EmptyState icon="download" title={t('downloadedEmptyTitle')} text={t('downloadedEmptyNote')} />
    );
  }

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: t('downloadedFilterAll'), count: videos.length },
    { key: 'music', label: t('downloadedFilterMusic'), count: musicVideos.length },
    { key: 'video', label: t('downloadedFilterVideos'), count: otherVideos.length },
  ];

  return (
    <div>
      <p className="section-title">{t('downloadedTitle')}</p>
      {/* Stránka neschovává soubory, jen si pamatuje, co sis stáhl. Dokud
          to tu nebylo napsané, jméno "Stažené" slibovalo offline, které
          appka neumí. */}
      <p className="downloaded-explainer">{t('downloadedExplainer')}</p>

      <div className="downloaded-toolbar">
        <div className="downloaded-filters" role="group" aria-label={t('downloadedTitle')}>
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? 'downloaded-filter downloaded-filter-active' : 'downloaded-filter'}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
            >
              {f.label}
              <span className="downloaded-filter-count">{f.count}</span>
            </button>
          ))}
        </div>

        {musicVideos.length > 0 && (
          <button type="button" className="downloaded-play-music" onClick={playAllMusic}>
            <PlayIcon size={14} />
            {t('downloadedPlayAllMusic')}
          </button>
        )}
      </div>

      {shown.length === 0 && query ? (
        <ScopedSearchEmpty query={rawQuery} />
      ) : shown.length === 0 ? (
        <p style={{ color: 'var(--text-faint)', fontSize: 13, padding: '24px 0' }}>
          {t('downloadedNothingHere')}
        </p>
      ) : (
        // Karty jsou teď stejné jako všude jinde, takže mají i nabídku pod
        // třemi tečkami - odtamtud jde stažené video přidat do playlistu
        // nebo do fronty, což tady dřív nešlo vůbec.
        <div className="video-grid">
          {shown.map((v: any) => (
            <div key={v.id} className="downloaded-item">
              <VideoCard video={v} href={`/watch/${v.id}`} formatDuration={formatDuration} />
              {/* Soubor na disku je, ale odkaz na něj dávno zmizel -
                  tohle je jediná věc, kvůli které má smysl sem chodit. */}
              {v.cloudflare_video_id && (
                <DownloadButton
                  videoId={v.id}
                  cloudflareVideoId={v.cloudflare_video_id}
                  label={t('downloadAgain')}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DownloadedPage() {
  return (
    <Suspense fallback={null}>
      <DownloadedPageInner />
    </Suspense>
  );
}
