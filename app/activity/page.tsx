'use client';

import { Suspense, useEffect, useState } from 'react';
import { useLanguage, DATE_LOCALES } from '@/lib/i18n';
import { useWatchProgress } from '@/lib/useWatchProgress';
import { useSearchParams } from 'next/navigation';
import { filterBySearch } from '@/lib/searchScope';
import ScopedSearchEmpty from '@/components/ScopedSearchEmpty';
import Link from 'next/link';
import Image from 'next/image';
import { supabase } from '@/lib/supabaseClient';
import { buildVideoBlocks } from '@/lib/videoBlocks';
import WatchCalendar, { dayKey } from '@/components/WatchCalendar';
import UiIcon, { type UiIconName } from '@/components/UiIcon';
import EmptyState from '@/components/EmptyState';
import { videoCountLabel } from '@/lib/plural';
import { VideoBlockRow } from '@/components/SparksShelf';

type Tab = 'liked' | 'disliked' | 'star5' | 'star4' | 'star3' | 'star2' | 'star1' | 'history';

function ActivityPageInner() {
  const { t, lang } = useLanguage();
  const searchParams = useSearchParams();
  const query = searchParams.get('q')?.toLowerCase() ?? '';
  // Hledání v knihovně (pole nahoře) - lib/searchScope.ts; původní text pro hlášku „nic tu není“.
  const rawQuery = searchParams.get('q') ?? '';
  const [ratingMode, setRatingMode] = useState<'stars' | 'like_dislike'>('like_dislike');
  const [tab, setTab] = useState<Tab>('liked');
  const [videosByScore, setVideosByScore] = useState<Record<number, any[]>>({});
  const [historyVideos, setHistoryVideos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  // Kalendář u zhlédnutých videí je schovaný - otevře se až kliknutím na 📅.
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      setLoading(false);
      return;
    }
    setUserId(authData.user.id);

    const { data: profile } = await supabase
      .from('profiles')
      .select('rating_mode')
      .eq('id', authData.user.id)
      .single();
    const mode = (profile?.rating_mode as 'stars' | 'like_dislike') ?? 'like_dislike';
    setRatingMode(mode);
    setTab(mode === 'stars' ? 'star5' : 'liked');

    // Appka natáhne všechny reakce (líbí/nelíbí i všechny úrovně hvězd),
    // ne jen tu vyfiltrovanou část - appka si je rozdělí sama
    // do jednotlivých skupin sama níž.
    const { data: reactions } = await supabase
      .from('video_reactions')
      .select('video_id, score')
      .eq('user_id', authData.user.id);

    const idsByScore: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    (reactions ?? []).forEach((r: any) => {
      const s = r.score ?? 3;
      if (idsByScore[s]) idsByScore[s].push(r.video_id);
    });

    const allRatedIds = Object.values(idsByScore).flat();
    if (allRatedIds.length > 0) {
      const { data } = await supabase
        .from('videos')
        .select('id, title, thumbnail_url, views, width, height, duration_seconds, profiles!videos_owner_id_fkey(username)')
        .in('id', allRatedIds)
        .eq('status', 'ready');

      const byScore: Record<number, any[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
      for (const score of [1, 2, 3, 4, 5]) {
        byScore[score] = idsByScore[score].map((id) => (data ?? []).find((v: any) => v.id === id)).filter(Boolean);
      }
      setVideosByScore(byScore);
    }

    const { data: history } = await supabase
      .from('watch_history')
      .select('video_id, watched_at')
      .eq('user_id', authData.user.id)
      .order('watched_at', { ascending: false });
    const historyIds = (history ?? []).map((h) => h.video_id);
    if (historyIds.length > 0) {
      const { data: videoData } = await supabase
        .from('videos')
        .select('id, title, thumbnail_url, views, width, height, duration_seconds, profiles!videos_owner_id_fkey(username)')
        .in('id', historyIds);
      const ordered = (history ?? []).map((h) => {
        const v = videoData?.find((x) => x.id === h.video_id);
        return v ? { ...v, watched_at: h.watched_at } : null;
      }).filter(Boolean);
      setHistoryVideos(ordered as any[]);
    }

    setLoading(false);
  }

  if (loading) return <p style={{ color: 'var(--text-faint)' }}>{t('loading')}</p>;

  if (!userId) {
    return (
      <div className="auth-gate">
        <p>{t('loginToViewStatsNote')}</p>
        <Link href="/login">{t('loginLink')}</Link>
      </div>
    );
  }

  const count = (score: number) => (videosByScore[score] ?? []).length;

  // Každá reakce má vlastní složku - lajky zvlášť, dislajky zvlášť, a
  // v hvězdičkovém režimu zvlášť každá úroveň hvězd. U každé záložky je
  // rovnou vidět, kolik v ní videí je.
  const TABS: { key: Tab; label: string; icon: UiIconName; count: number }[] =
    ratingMode === 'stars'
      ? [
          { key: 'star5', label: '5★', icon: 'starFilled', count: count(5) },
          { key: 'star4', label: '4★', icon: 'starFilled', count: count(4) },
          { key: 'star3', label: '3★', icon: 'star', count: count(3) },
          { key: 'star2', label: '2★', icon: 'star', count: count(2) },
          { key: 'star1', label: '1★', icon: 'star', count: count(1) },
          { key: 'history', label: t('activityWatchedTab'), icon: 'eye', count: historyVideos.length },
        ]
      : [
          { key: 'liked', label: t('activityLikedTab'), icon: 'thumbUp', count: count(5) },
          { key: 'disliked', label: t('activityDislikedTab'), icon: 'thumbUp', count: count(1) },
          { key: 'history', label: t('activityWatchedTab'), icon: 'eye', count: historyVideos.length },
        ];

  const activeList: any[] =
    tab === 'history' ? historyVideos
    : tab === 'liked' ? videosByScore[5] ?? []
    : tab === 'disliked' ? videosByScore[1] ?? []
    : videosByScore[Number(tab.replace('star', ''))] ?? [];

  const byQuery = filterBySearch(activeList, query);

  // Kolik videí padlo na který den - podle toho se v kalendáři zvýrazní dny,
  // ve kterých je vůbec co hledat. Počítá se až z výsledků hledání, ne ze
  // všech videí: jinak by kalendář nabízel dny, které po zadání hledaného
  // slova dopadnou prázdné.
  const countsByDay: Record<string, number> = {};
  if (tab === 'history') {
    for (const video of byQuery) {
      if (!video.watched_at) continue;
      const key = dayKey(video.watched_at);
      countsByDay[key] = (countsByDay[key] ?? 0) + 1;
    }
  }
  const filtered =
    tab === 'history' && selectedDay
      ? byQuery.filter((v) => v.watched_at && dayKey(v.watched_at) === selectedDay)
      : byQuery;

  function renderVideoGrid(list: any[]) {
    return buildVideoBlocks(list).map((block, bi) => (
      <VideoBlockRow key={bi} type={block.type} style={{ marginBottom: 20 }}>
        {block.items.map((video: any) => (
          <Link
            href={block.type === 'sparks' ? `/sparks?start=${video.id}` : `/watch/${video.id}`}
            key={video.id}
            className="video-card"
          >
            <div className={block.type === 'sparks' ? 'video-thumb video-thumb-vertical' : 'video-thumb'}>
              {video.thumbnail_url ? (
                <Image src={video.thumbnail_url} alt={video.title} width={320} height={180} />
              ) : null}
              <div className="play-badge">▶</div>
            </div>
            <p className="video-card-title">{video.title}</p>
            <p className="video-card-meta">
              {video.profiles?.username ?? t('unknownCreator')} · {video.views} {t('views')}
            </p>
          </Link>
        ))}
      </VideoBlockRow>
    ));
  }

  // Historie je rozdělená podle dne, kdy uživatel video naposledy viděl
  // (Dnes / Včera / konkrétní datum). Bez klikání je to prostě přehled po
  // dnech; kdo chce jeden konkrétní den, otevře si nahoře 📅 Kalendář.
  function renderHistoryGroupedByDay(list: any[]) {
    const groups: { label: string; items: any[] }[] = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

    for (const video of list) {
      const d = new Date(video.watched_at); d.setHours(0, 0, 0, 0);
      let label: string;
      if (d.getTime() === today.getTime()) label = t('todayLabel');
      else if (d.getTime() === yesterday.getTime()) label = t('yesterdayLabel');
      else label = new Date(video.watched_at).toLocaleDateString(DATE_LOCALES[lang], { day: 'numeric', month: 'long', year: 'numeric' });

      let group = groups.find((g) => g.label === label);
      if (!group) { group = { label, items: [] }; groups.push(group); }
      group.items.push(video);
    }

    return groups.map((g) => (
      <div key={g.label} style={{ marginBottom: 28 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 12 }}>
          {g.label}
          <span style={{ fontWeight: 400, color: 'var(--text-faint)', marginLeft: 8 }}>
            · {videoCountLabel(g.items.length, lang, t)}
          </span>
        </p>
        {renderVideoGrid(g.items)}
      </div>
    ));
  }

  return (
    <div>
      <p className="section-title">{t('yourActivityTitle')}</p>

      <div className="tab-row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map(({ key, label, icon, count: n }) => (
          <button
            key={key}
            type="button"
            className={`tab-btn activity-tab ${tab === key ? 'active' : ''}`}
            onClick={() => { setTab(key); if (key !== 'history') setSelectedDay(null); }}
          >
            {ratingMode !== 'stars' || key === 'history' ? <UiIcon name={icon} size={14} className={key === 'disliked' ? 'flip-v' : undefined} /> : null}
            {label} <span className="yv-tab-count">{n}</span>
          </button>
        ))}
      </div>

      {tab === 'history' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <button
              onClick={() => setCalendarOpen((v) => !v)}
              className={`tab-btn ${calendarOpen || selectedDay ? 'active' : ''}`}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <UiIcon name="calendar" size={15} />
              {calendarOpen ? t('activityHideCalendar') : t('activityCalendar')}
            </button>
            {selectedDay && (
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                {new Date(`${selectedDay}T00:00:00`).toLocaleDateString(DATE_LOCALES[lang], {
                  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                })}
                {' · '}
                <button
                  onClick={() => setSelectedDay(null)}
                  style={{ background: 'none', color: 'var(--brand)', padding: 0, fontSize: 13 }}
                >
                  {t('activityClearShort')}
                </button>
              </span>
            )}
          </div>

          {calendarOpen && (
            <WatchCalendar
              countsByDay={countsByDay}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
            />
          )}
        </>
      )}

      {filtered.length === 0 && query ? (
        <ScopedSearchEmpty query={rawQuery} />
      ) : filtered.length === 0 ? (
        <EmptyState
          compact
          icon={tab === 'history' ? 'eye' : tab === 'liked' || tab === 'disliked' ? 'thumbUp' : 'star'}
          title={tab === 'history' ? (selectedDay ? t('activityNothingThatDay') : t('activityHistoryEmpty')) : t('activityCategoryEmpty')}
        />
      ) : tab === 'history' ? (
        renderHistoryGroupedByDay(filtered)
      ) : (
        renderVideoGrid(filtered)
      )}
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={null}>
      <ActivityPageInner />
    </Suspense>
  );
}
