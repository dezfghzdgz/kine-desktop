'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useLanguage, DATE_LOCALES } from '@/lib/i18n';
import { useSearchParams } from 'next/navigation';
import { filterBySearch } from '@/lib/searchScope';
import ScopedSearchEmpty from '@/components/ScopedSearchEmpty';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import ConfirmDialog from '@/components/ConfirmDialog';
import Toast, { type ToastType } from '@/components/Toast';
import UiIcon from '@/components/UiIcon';
import EmptyState from '@/components/EmptyState';
import { formatTime } from '@/lib/playerControls';
import { isSpark } from '@/lib/videoBlocks';

type Tab = 'all' | 'videos' | 'sparks' | 'clips';

/** Co seznam potřebuje; bez novějších sloupců (klipy, plánování) se načte základ. */
const FIELDS = 'id, title, thumbnail_url, views, status, visibility, width, height, duration_seconds, created_at, scheduled_at, is_premiere, clipped_by';
const BASIC_FIELDS = 'id, title, thumbnail_url, views, status, visibility, width, height, duration_seconds, created_at';

async function fetchMine(ownerId: string): Promise<any[]> {
  const full = await supabase.from('videos').select(FIELDS).eq('owner_id', ownerId).order('created_at', { ascending: false });
  if (!full.error) return full.data ?? [];
  const basic = await supabase.from('videos').select(BASIC_FIELDS).eq('owner_id', ownerId).order('created_at', { ascending: false });
  return basic.data ?? [];
}

/**
 * Vaše videa - přehled obsahu kanálu jako ve studiu: záložky (videa, Sparks,
 * klipy od diváků), řádky se stavem (zpracovává se, soukromé, naplánované),
 * zhlédnutími a akcemi. Zpracovávaná videa se doptávají sama.
 */
function YourVideosPageInner() {
  const { t, lang } = useLanguage();
  const searchParams = useSearchParams();
  const query = searchParams.get('q')?.toLowerCase() ?? '';
  // Hledání v knihovně (pole nahoře) - lib/searchScope.ts; původní text pro hlášku „nic tu není“.
  const rawQuery = searchParams.get('q') ?? '';
  const [videos, setVideos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmVideoId, setConfirmVideoId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      setLoading(false);
      return;
    }
    const list = await fetchMine(authData.user.id);
    setVideos(list);
    setLoading(false);

    await doptejSeNaZpracovavana(list, authData.user.id);
    await dorovnejOchranu();
  }

  /**
   * Podepsané adresy pro neveřejná videa (lib/streamProtection.ts): ochrana
   * se zapíná při uložení videa - videa, která byla soukromá dřív, než
   * ochrana vznikla, by na ni čekala, dokud je někdo neupraví. Tady se
   * dorovnají všechna naráz, jednou za otevření appky. Bez nastaveného
   * klíče server odpoví "not-configured" a nic se neděje.
   */
  async function dorovnejOchranu() {
    const KLIC = 'kine-ochrana-dorovnana';
    try {
      if (sessionStorage.getItem(KLIC)) return;
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) return;
      const res = await fetch('/api/videos/protect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ all: true }),
      });
      const body = await res.json().catch(() => ({}));
      // Po neúspěchu se to příště zkusí znovu; jinak stačí jednou.
      if (res.ok && body.outcome !== 'failed') sessionStorage.setItem(KLIC, '1');
      // Když se přenesl náhled, ať je hned vidět.
      if (body.changed > 0) load();
    } catch {
      // Ochrana není důvod, aby seznam videí nešel.
    }
  }

  /**
   * Doptá se Cloudflare na videa, která se ještě zpracovávají (na "ready" je
   * přepne teprve někdo, kdo se zeptá). Opakuje se samo, dokud je co dodělávat.
   */
  async function doptejSeNaZpracovavana(list: any[], ownerId: string) {
    // Jen ta, co se ještě zpracovávají - nepovedené ("failed") už hotová nebudou.
    const zpracovavana = list.filter((v: any) => v.status === 'processing');
    if (zpracovavana.length === 0) return;

    await Promise.all(
      zpracovavana.map((v: any) =>
        fetch('/api/videos/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: v.id }),
        }).catch(() => null)
      )
    );
    setVideos(await fetchMine(ownerId));
  }

  // Dokud se něco zpracovává, ptá se stránka sama dokola (jen když je karta vidět).
  useEffect(() => {
    const zpracovavana = videos.filter((v: any) => v.status === 'processing');
    if (zpracovavana.length === 0) return;

    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) return;
      await doptejSeNaZpracovavana(videos, authData.user.id);
    }, 15000);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  async function handleDelete(videoId: string) {
    setDeletingId(videoId);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch('/api/videos/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session?.access_token}` },
        body: JSON.stringify({ videoId }),
      });
      if (res.ok) {
        setVideos((prev) => prev.filter((v) => v.id !== videoId));
      } else {
        const data = await res.json().catch(() => ({}));
        setToast({ message: `${t('yvDeleteFailed')}${data?.error ? ` ${data.error}` : ''}`, type: 'error' });
      }
    } catch {
      setToast({ message: t('yvDeleteFailed'), type: 'error' });
    } finally {
      setDeletingId(null);
    }
  }

  const counts = useMemo(
    () => ({
      all: videos.length,
      videos: videos.filter((v) => !isSpark(v) && !v.clipped_by).length,
      sparks: videos.filter((v) => isSpark(v) && !v.clipped_by).length,
      clips: videos.filter((v) => !!v.clipped_by).length,
    }),
    [videos]
  );
  const totalViews = useMemo(() => videos.reduce((s, v) => s + (Number(v.views) || 0), 0), [videos]);

  if (loading) return <p style={{ color: 'var(--text-faint)' }}>{t('loading')}</p>;

  if (videos.length === 0) {
    return (
      <EmptyState
        icon="film"
        title={t('noVideosUploadedYet')}
        action={
          <Link href="/upload" className="yv-upload-btn">
            <UiIcon name="upload" size={15} /> {t('uploadFirstVideo')}
          </Link>
        }
      />
    );
  }

  const byTab = videos.filter((v) => (tab === 'all' ? true : tab === 'clips' ? !!v.clipped_by : tab === 'sparks' ? isSpark(v) && !v.clipped_by : !isSpark(v) && !v.clipped_by));
  const filtered = filterBySearch(byTab, query);
  const number = new Intl.NumberFormat(DATE_LOCALES[lang]);
  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: t('yvTabAll') },
    { key: 'videos', label: t('yvTabVideos') },
    { key: 'sparks', label: t('yvTabSparks') },
    ...(counts.clips > 0 ? [{ key: 'clips' as Tab, label: t('yvTabClips') }] : []),
  ];

  return (
    <div className="yv-page">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <header className="yv-head">
        <div>
          <h1 className="yv-title">{t('yourVideosTitle')}</h1>
          <p className="yv-sub">
            {t('yvSummary').replace('{n}', number.format(videos.length)).replace('{views}', number.format(totalViews))}
          </p>
        </div>
        <div className="yv-head-actions">
          <Link href="/channel-stats" className="yv-ghost-btn">
            <UiIcon name="chart" size={15} /> {t('channelStatsTitle')}
          </Link>
          <Link href="/upload" className="yv-upload-btn">
            <UiIcon name="upload" size={15} /> {t('uploadVideo')}
          </Link>
        </div>
      </header>

      <div className="tab-row yv-tabs" role="tablist">
        {tabs.map(({ key, label }) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label} <span className="yv-tab-count">{counts[key]}</span>
          </button>
        ))}
      </div>

      {query && filtered.length === 0 && <ScopedSearchEmpty query={rawQuery} />}
      {!query && filtered.length === 0 && <EmptyState compact icon={tab === 'sparks' ? 'bolt' : tab === 'clips' ? 'scissors' : 'film'} title={t('yvTabEmpty')} />}

      <ul className="yv-list">
        {filtered.map((video: any) => {
          const spark = isSpark(video);
          const scheduled = video.scheduled_at && Date.parse(video.scheduled_at) > Date.now() ? video.scheduled_at : null;
          return (
            <li key={video.id} className="yv-row">
              <Link href={`/watch/${video.id}`} className={`yv-thumb${spark ? ' spark' : ''}`} tabIndex={-1} aria-hidden="true">
                {video.thumbnail_url ? <img src={video.thumbnail_url} alt="" loading="lazy" decoding="async" /> : <UiIcon name="film" size={20} />}
                {video.duration_seconds ? <span className="yv-duration">{formatTime(video.duration_seconds)}</span> : null}
              </Link>
              <div className="yv-info">
                <Link href={`/watch/${video.id}`} className="yv-video-title">
                  {video.title || '—'}
                </Link>
                <p className="yv-meta">
                  {video.status === 'processing' ? (
                    <span className="yv-badge processing">
                      <span className="spin" aria-hidden="true" /> {t('videoStatusProcessing')}
                    </span>
                  ) : video.status === 'failed' ? (
                    <span className="yv-badge failed">
                      <UiIcon name="warning" size={12} /> {t('videoStatusFailed')}
                    </span>
                  ) : scheduled ? (
                    <span className="yv-badge scheduled">
                      <UiIcon name="calendar" size={12} />{' '}
                      {t('yvScheduled').replace('{time}', new Date(scheduled).toLocaleString(DATE_LOCALES[lang], { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }))}
                    </span>
                  ) : (
                    <span className={`yv-badge ${video.visibility === 'public' ? 'public' : 'private'}`}>
                      <UiIcon name={video.visibility === 'public' ? 'globe' : video.visibility === 'subscribers' ? 'users' : 'lock'} size={12} />{' '}
                      {video.visibility === 'private' ? t('shortVisibilityPrivate') : video.visibility === 'subscribers' ? t('shortVisibilitySubscribers') : t('shortVisibilityPublic')}
                    </span>
                  )}
                  {spark && <span className="yv-badge kind">Sparks</span>}
                  {video.clipped_by && (
                    <span className="yv-badge kind">
                      <UiIcon name="scissors" size={12} /> {t('yvClipBadge')}
                    </span>
                  )}
                  <span className="yv-meta-text">
                    {video.status === 'ready' && (
                      <>
                        <UiIcon name="eye" size={12} /> {number.format(video.views ?? 0)}
                        {' · '}
                      </>
                    )}
                    {new Date(video.created_at).toLocaleDateString(DATE_LOCALES[lang])}
                  </span>
                </p>
              </div>
              <div className="yv-actions">
                <Link href={`/your-videos/${video.id}/edit`} className="yv-action" title={t('edit')} aria-label={t('edit')}>
                  <UiIcon name="pencil" size={15} />
                  <span>{t('edit')}</span>
                </Link>
                <Link href={`/watch/${video.id}`} className="yv-action icon-only" title={t('liveOpenVideo')} aria-label={t('liveOpenVideo')}>
                  <UiIcon name="play" size={15} />
                </Link>
                <button
                  type="button"
                  className="yv-action icon-only danger"
                  onClick={() => setConfirmVideoId(video.id)}
                  disabled={deletingId === video.id}
                  title={t('deleteVideoBtn')}
                  aria-label={t('deleteVideoBtn')}
                >
                  {deletingId === video.id ? <span className="spin" aria-hidden="true" /> : <UiIcon name="trash" size={15} />}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {confirmVideoId && (
        <ConfirmDialog
          message={t('confirmDeleteVideo')}
          onConfirm={() => {
            handleDelete(confirmVideoId);
            setConfirmVideoId(null);
          }}
          onCancel={() => setConfirmVideoId(null)}
        />
      )}
    </div>
  );
}

export default function YourVideosPage() {
  return (
    <Suspense fallback={null}>
      <YourVideosPageInner />
    </Suspense>
  );
}
