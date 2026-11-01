'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useLanguage, DATE_LOCALES } from '@/lib/i18n';
import { CATEGORY_KEYS } from '@/lib/categories';
import { GAMING_CATEGORY } from '@/lib/games';
import GameSelect from '@/components/GameSelect';
import { channelRoom, liveElapsed } from '@/lib/liveChat';
import LiveChat from '@/components/LiveChat';
import ChatEmoteManager from '@/components/ChatEmoteManager';
import { useChatEmotes } from '@/lib/useChatEmotes';
import LiveTipsPanel from '@/components/LiveTipsPanel';
import ComingSoon from '@/components/ComingSoon';
import { CREATOR_PAYMENTS_ENABLED } from '@/lib/payments';
import ConfirmDialog from '@/components/ConfirmDialog';
import Toast, { ToastType } from '@/components/Toast';
import { PanelHeading, WithHelp } from '@/components/HelpTip';
import FieldHint from '@/components/FieldHint';
import UiIcon from '@/components/UiIcon';
import { liveThumbnailJpeg } from '@/lib/liveThumbnail';
import LiveRaidPanel from '@/components/LiveRaidPanel';
import LiveSchedulePanel from '@/components/LiveSchedulePanel';

type Setup = {
  configured: boolean;
  migrated: boolean;
  input: { rtmpsUrl: string; streamKey: string; srtUrl: string | null; createdAt: string } | null;
  stream: {
    title: string;
    description: string;
    category: string | null;
    /** Hra (lib/games.ts - slug); starší server ji neposílá. */
    game?: string | null;
    live: boolean;
    startedAt: string | null;
    endedAt: string | null;
    /** null = Cloudflare přenos ještě nepotvrdil (a kód zákazníka není znám) - náhled zatím není. */
    playerUrl: string | null;
    /** Od kdy ukazovat chat - každé vysílání má svůj (lib/liveChat.ts). */
    chatSince?: string | null;
    /** Vlastní náhled přenosu (null = snímek z vysílání). */
    thumbnailUrl?: string | null;
  } | null;
  /** Co se záznamem po skončení (null = nechat ve studiu). */
  recordingVisibility?: 'public' | 'subscribers' | 'private' | null;
  /** Databáze to umí (migrace supabase-migration-zive-2.sql). */
  recordingAutoSupported?: boolean;
  /** Běžící přenos skrytý kontrolou obsahu - čeká na moderátora (app/api/live/me). */
  moderation?: { hidden: boolean };
  /** Kolik dní zůstane nezveřejněný záznam (lib/liveLimits.ts; starší Kine nic - pak 30). */
  recordingKeepDays?: number;
  /** Vstup pro vysílání vypnutý: zablokovaný účet, nebo moc dlouhý přenos (do kdy). */
  inputDisabled?: { reason: 'ban' | 'too-long' | string | null; until: string | null; maxHours?: number } | null;
};

type Moderator = { userId: string; username: string | null };

type Recording = {
  uid: string;
  state: string;
  created: string | null;
  duration: number | null;
  thumbnail: string | null;
  readyToStream: boolean;
  videoId: string | null;
};

function formatDuration(seconds: number | null): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Studio živého vysílání: klíč pro OBS, název a popis přenosu, náhled,
 * chat (s mazáním) a záznamy, které jde jedním klikem zveřejnit jako video.
 */
export default function LiveStudioPage() {
  const { t, lang } = useLanguage();
  const [token, setToken] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('catGaming');
  const [game, setGame] = useState<string>('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [publishing, setPublishing] = useState<{ uid: string; title: string; visibility: 'public' | 'subscribers' | 'private' } | null>(null);
  /** Záznam, který se chystá ke stažení (Cloudflare vyrábí MP4) / je připravený, nebo se ptá na zahození. */
  const [recDownload, setRecDownload] = useState<{ uid: string; percent: number | null; url: string | null } | null>(null);
  const [recDiscard, setRecDiscard] = useState<string | null>(null);
  /** Po odchodu ze studia se na MP4 už neptá. */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [streamLive, setStreamLive] = useState(false);
  const [moderators, setModerators] = useState<Moderator[]>([]);
  const [newModerator, setNewModerator] = useState('');
  const wasLiveRef = useRef(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const detailsTouchedRef = useRef(false);
  const [thumbBusy, setThumbBusy] = useState(false);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  /** Kolikrát se ve studiu něco uložilo - starší odpovědi pravidelného dotazu se zahodí. */
  const setupWriteRef = useRef(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
      setUserId(data.session?.user?.id ?? null);
      setChecked(true);
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  }

  async function loadSetup() {
    const asked = setupWriteRef.current;
    try {
      const body: Setup = await api('/api/live/me');
      // Mezitím se ve studiu něco uložilo (náhled, údaje, klíč): tahle odpověď je starší
      // a přepsala by to na 5 s zpátky - další dotaz přinese čerstvý stav.
      if (asked !== setupWriteRef.current) return;
      setSetup(body);
      setLoadError(null);
      if (body.stream && !detailsTouchedRef.current) {
        setTitle(body.stream.title ?? '');
        setDescription(body.stream.description ?? '');
        if (body.stream.category) setCategory(body.stream.category);
        setGame(body.stream.game ?? '');
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  async function loadRecordings() {
    try {
      const body = await api('/api/live/recordings');
      setRecordings(Array.isArray(body.recordings) ? body.recordings : []);
      setStreamLive(!!body.streamLive);
    } catch {
      // Záznamy nejsou k dispozici - sekce zůstane prázdná.
    }
  }

  async function loadModerators() {
    try {
      const body = await api('/api/live/moderators');
      setModerators(Array.isArray(body.moderators) ? body.moderators : []);
    } catch {
      // Bez migrace seznam moderátorů prostě není.
    }
  }

  // Vysílání právě skončilo: záznam se objeví hned (Cloudflare ho ještě minutu
  // uzavírá - zveřejnit jde už teď) a ještě jednou, až bude hotový.
  useEffect(() => {
    const live = !!setup?.stream?.live;
    if (wasLiveRef.current && !live) {
      const a = setTimeout(loadRecordings, 4000);
      const b = setTimeout(loadRecordings, 75000);
      wasLiveRef.current = live;
      return () => {
        clearTimeout(a);
        clearTimeout(b);
      };
    }
    wasLiveRef.current = live;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup?.stream?.live]);

  useEffect(() => {
    if (!token) return;
    loadSetup();
    loadRecordings();
    loadModerators();
    // Stav (živě / offline) každých 5 s - studio je otevřené hlavně při vysílání.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadSetup();
    }, 5000);
    const recTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadRecordings();
    }, 60 * 1000);
    return () => {
      clearInterval(timer);
      clearInterval(recTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function createKey(action: 'create' | 'reset') {
    setBusy(true);
    try {
      const body = await api('/api/live/me', { method: 'POST', body: JSON.stringify({ action }) });
      setupWriteRef.current += 1;
      setSetup((s) => (s ? { ...s, input: body.input, stream: body.stream ?? s.stream } : s));
      setShowKey(false);
      if (action === 'reset') setToast({ message: t('liveKeyResetDone'), type: 'success' });
    } catch (e) {
      setToast({ message: (e as Error).message, type: 'error' });
    } finally {
      setBusy(false);
      setConfirmReset(false);
    }
  }

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavingDetails(true);
    try {
      // Hra jen u kategorie Hry (jinak se smaže - u vaření nedává smysl).
      const body = await api('/api/live/me', { method: 'POST', body: JSON.stringify({ action: 'details', title, description, category, game: category === GAMING_CATEGORY ? game || null : null }) });
      setupWriteRef.current += 1;
      setSetup((s) => (s ? { ...s, stream: body.stream } : s));
      detailsTouchedRef.current = false;
      setToast({ message: t('liveSaved'), type: 'success' });
    } catch (err) {
      setToast({ message: (err as Error).message, type: 'error' });
    } finally {
      setSavingDetails(false);
    }
  }

  /** Vlastní náhled přenosu: zmenší se na 1280×720 (JPEG) a hned uloží - bez tlačítka Uložit. */
  async function uploadThumbnail(file: File) {
    setThumbBusy(true);
    try {
      const jpeg = await liveThumbnailJpeg(file);
      if (!jpeg) throw new Error(t('liveThumbUnreadable'));
      const res = await fetch('/api/live/thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: jpeg,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setupWriteRef.current += 1;
      setSetup((s) => (s && s.stream ? { ...s, stream: { ...s.stream, thumbnailUrl: body.thumbnailUrl ?? null } } : s));
      setToast({ message: t('liveThumbSaved'), type: 'success' });
    } catch (e) {
      setToast({ message: (e as Error).message, type: 'error' });
    } finally {
      setThumbBusy(false);
      if (thumbInputRef.current) thumbInputRef.current.value = '';
    }
  }

  async function removeThumbnail() {
    setThumbBusy(true);
    try {
      await api('/api/live/thumbnail', { method: 'DELETE' });
      setupWriteRef.current += 1;
      setSetup((s) => (s && s.stream ? { ...s, stream: { ...s.stream, thumbnailUrl: null } } : s));
      setToast({ message: t('liveThumbRemoved'), type: 'success' });
    } catch (e) {
      setToast({ message: (e as Error).message, type: 'error' });
    } finally {
      setThumbBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast({ message: t('liveCopied'), type: 'success' });
    } catch {
      setToast({ message: text, type: 'error' });
    }
  }

  async function publish() {
    if (!publishing) return;
    setBusy(true);
    try {
      const body = await api('/api/live/recordings', {
        method: 'POST',
        body: JSON.stringify({ videoUid: publishing.uid, title: publishing.title, description, visibility: publishing.visibility, language: lang }),
      });
      setRecordings((list) => list.map((r) => (r.uid === publishing.uid ? { ...r, videoId: body.videoId } : r)));
      setPublishing(null);
      setToast({ message: t('livePublished'), type: 'success' });
    } catch (e) {
      setToast({ message: (e as Error).message, type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Stáhnout záznam do PC: Cloudflare MP4 nejdřív vyrobí (u dlouhého vysílání pár
   * minut) - ptá se znovu, dokud není hotové; pak se ukáže odkaz na uložení (okno
   * otevřené až po čekání by prohlížeč zablokoval).
   */
  async function downloadRecording(uid: string) {
    setRecDownload({ uid, percent: null, url: null });
    try {
      for (let attempt = 0; attempt < 240; attempt++) {
        if (!mountedRef.current) return;
        const body = await api('/api/live/recordings/download', { method: 'POST', body: JSON.stringify({ videoUid: uid }) });
        if (body.status === 'ready' && body.url) {
          setRecDownload({ uid, percent: 100, url: body.url });
          return;
        }
        setRecDownload({ uid, percent: typeof body.percent === 'number' ? Math.round(body.percent) : null, url: null });
        await new Promise((r) => setTimeout(r, 3000));
      }
      setRecDownload(null);
      setToast({ message: t('liveRecNotReady'), type: 'error' });
    } catch (e) {
      setRecDownload(null);
      setToast({ message: (e as Error).message, type: 'error' });
    }
  }

  async function discardRecording(uid: string) {
    setBusy(true);
    try {
      await api('/api/live/recordings/discard', { method: 'POST', body: JSON.stringify({ videoUid: uid }) });
      setRecordings((list) => list.filter((r) => r.uid !== uid));
      setToast({ message: t('liveRecDiscarded'), type: 'success' });
    } catch (e) {
      setToast({ message: (e as Error).message, type: 'error' });
    } finally {
      setBusy(false);
      setRecDiscard(null);
    }
  }

  async function saveAfterStream(value: string) {
    try {
      const body = await api('/api/live/me', { method: 'POST', body: JSON.stringify({ action: 'details', recordingVisibility: value === 'off' ? null : value }) });
      setSetup((s) => (s ? { ...s, recordingVisibility: body.recordingVisibility ?? null, recordingAutoSupported: body.recordingAutoSupported !== false } : s));
      setToast(body.recordingAutoSupported === false ? { message: t('liveAfterStreamNeedsMigration'), type: 'error' } : { message: t('liveSaved'), type: 'success' });
    } catch (e) {
      setToast({ message: (e as Error).message, type: 'error' });
    }
  }

  async function changeModerators(payload: Record<string, unknown>) {
    try {
      const body = await api('/api/live/moderators', { method: 'POST', body: JSON.stringify(payload) });
      setModerators(Array.isArray(body.moderators) ? body.moderators : []);
      setNewModerator('');
    } catch (e) {
      setToast({ message: (e as Error).message, type: 'error' });
    }
  }

  if (!checked) return <p style={{ color: 'var(--text-faint)' }}>{t('loading')}</p>;
  if (!token || !userId) {
    return (
      <div className="auth-gate">
        <p>{t('liveSignInToStream')}</p>
        <Link href="/login?next=%2Flive">{t('loginLink')}</Link>
      </div>
    );
  }
  if (!setup) {
    return loadError ? (
      <div className="auth-gate">
        <p>{loadError}</p>
      </div>
    ) : (
      <p style={{ color: 'var(--text-faint)' }}>{t('loading')}</p>
    );
  }

  const stream = setup.stream;
  const input = setup.input;

  return (
    <div className="live-studio">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      {confirmReset && (
        <ConfirmDialog message={t('liveResetKeyConfirm')} onConfirm={() => createKey('reset')} onCancel={() => setConfirmReset(false)} />
      )}
      <h1 className="section-title" style={{ fontSize: 'var(--fs-2xl)' }}>
        <span className="live-dot" aria-hidden="true" /> {t('liveStudioTitle')}
      </h1>

      {!setup.migrated && <p className="feed-notice">{t('liveNotMigratedNote')}</p>}
      {setup.migrated && !setup.configured && <p className="feed-notice">{t('liveNotConfiguredNote')}</p>}

      {setup.migrated && setup.configured && !input && (
        <div className="panel live-intro">
          {/* Co studio umí: za otazníčkem vedle tlačítka (heslovitě), ne odstavec. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button type="button" onClick={() => createKey('create')} disabled={busy}>
              {busy ? t('liveCreating') : t('liveCreateKeyButton')}
            </button>
            <FieldHint text={t('liveStudioIntro')} />
          </div>
        </div>
      )}

      {input && (
        <div className="live-studio-grid">
          <div className="live-studio-main panel-stack">
            <div className="panel live-status-panel">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                {stream?.live ? (
                  <p className="live-status live-status-on">
                    <span className="live-pill">● {t('liveBadge')}</span> {t('liveStatusLive')}
                    {stream.startedAt && <span className="live-status-time">{liveElapsed(stream.startedAt, now)}</span>}
                  </p>
                ) : (
                  <p className="live-status">
                    <span className="live-status-off-dot" aria-hidden="true" /> {t('liveStatusOffline')}
                  </p>
                )}
                <Link href={`/live/${userId}`} className="live-studio-link">
                  {t('liveOpenPublicPage')} →
                </Link>
              </div>
              {stream?.live && setup.moderation?.hidden && (
                <div className="moderation-hold-note" role="status" style={{ marginTop: 12, marginBottom: 0 }}>
                  <UiIcon name="warning" size={18} />
                  <span>{t('liveHeldOwner')}</span>
                </div>
              )}
              {setup.inputDisabled && (
                <div className="moderation-hold-note" role="status" style={{ marginTop: 12, marginBottom: 0 }}>
                  <UiIcon name="warning" size={18} />
                  <span>
                    {setup.inputDisabled.reason === 'ban'
                      ? t('liveInputDisabledBan')
                      : t('liveInputDisabledLong')
                          .replace('{hours}', String(setup.inputDisabled.maxHours ?? 12))
                          .replace('{time}', setup.inputDisabled.until ? new Date(setup.inputDisabled.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '…')}
                  </span>
                </div>
              )}
              {stream?.live && stream.playerUrl && (
                <div className="player-wrap" style={{ aspectRatio: '16/9', marginTop: 12 }}>
                  <iframe
                    src={`${stream.playerUrl}${stream.playerUrl.includes('?') ? '&' : '?'}muted=true`}
                    style={{ width: '100%', height: '100%', border: 'none' }}
                    allow="autoplay; encrypted-media; picture-in-picture; fullscreen;"
                    allowFullScreen
                    title={t('liveStudioTitle')}
                  />
                </div>
              )}
            </div>

            {/* Raid: na konci vysílání poslat diváky k někomu, kdo právě vysílá (jen během vysílání). */}
            {stream?.live && <LiveRaidPanel token={token} userId={userId} live={!!stream.live} onToast={(message, type) => setToast({ message, type })} />}

            <form className="panel" onSubmit={saveDetails} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <PanelHeading icon="info" title={t('liveDetailsHeading')} />
              <label className="live-field">
                <span>{t('liveTitleLabel')}</span>
                <input
                  type="text"
                  value={title}
                  maxLength={100}
                  onChange={(e) => {
                    detailsTouchedRef.current = true;
                    setTitle(e.target.value);
                  }}
                />
              </label>
              <label className="live-field">
                <span>{t('description2')}</span>
                <textarea
                  rows={3}
                  value={description}
                  maxLength={2000}
                  onChange={(e) => {
                    detailsTouchedRef.current = true;
                    setDescription(e.target.value);
                  }}
                />
              </label>
              <label className="live-field">
                <span>{t('categoryLabel')}</span>
                <select
                  value={category}
                  onChange={(e) => {
                    detailsTouchedRef.current = true;
                    setCategory(e.target.value);
                  }}
                >
                  {CATEGORY_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {t(key as any)}
                    </option>
                  ))}
                </select>
              </label>
              {category === GAMING_CATEGORY && (
                <label className="live-field">
                  <span>{t('gameLabel')}</span>
                  <GameSelect
                    value={game}
                    onChange={(slug) => {
                      detailsTouchedRef.current = true;
                      setGame(slug);
                    }}
                  />
                  <span className="live-field-hint">{t('gameLiveHint')}</span>
                </label>
              )}
              <div>
                <button type="submit" disabled={savingDetails}>
                  {t('saveChanges')}
                </button>
              </div>
            </form>

            {/* Náhled přenosu: vlastní obrázek, jinak snímek z vysílání (jako na YouTube / Twitchi). */}
            <div className="panel">
              <PanelHeading icon="image" title={t('liveThumbHeading')} help={t('liveThumbHint')} />
              <div className="live-thumb-row">
                <div className="live-thumb-preview">
                  {stream?.thumbnailUrl ? (
                    <img src={stream.thumbnailUrl} alt="" decoding="async" />
                  ) : (
                    <span className="live-thumb-auto">
                      <UiIcon name="broadcast" size={18} />
                      {t('liveThumbAuto')}
                    </span>
                  )}
                </div>
                <div className="live-thumb-actions">
                  <input
                    ref={thumbInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadThumbnail(file);
                    }}
                  />
                  <button type="button" className="live-small-btn" onClick={() => thumbInputRef.current?.click()} disabled={thumbBusy || !stream}>
                    {thumbBusy ? t('liveThumbSaving') : stream?.thumbnailUrl ? t('liveThumbChange') : t('liveThumbUpload')}
                  </button>
                  {stream?.thumbnailUrl && (
                    <button type="button" className="live-small-btn" onClick={removeThumbnail} disabled={thumbBusy}>
                      {t('liveThumbRemove')}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Plánované vysílání: odpočet s „Připomenout“ na kanálu a u přenosu. */}
            <LiveSchedulePanel
              token={token}
              userId={userId}
              defaultTitle={title}
              game={category === GAMING_CATEGORY ? game || null : null}
              onToast={(message, type) => setToast({ message, type })}
            />

            <div className="panel">
              <PanelHeading icon="sliders" title={t('liveObsHeading')} />
              <div className="live-key-row">
                <span className="live-key-label">{t('liveServerLabel')}</span>
                <code className="live-key-value">{input.rtmpsUrl}</code>
                <button type="button" className="live-small-btn" onClick={() => copy(input.rtmpsUrl)}>
                  {t('liveCopy')}
                </button>
              </div>
              <div className="live-key-row">
                <span className="live-key-label">{t('liveKeyLabel')}</span>
                <code className="live-key-value">{showKey ? input.streamKey : '•'.repeat(Math.min(32, input.streamKey.length))}</code>
                <button type="button" className="live-small-btn" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? t('liveKeyHide') : t('liveKeyShow')}
                </button>
                <button type="button" className="live-small-btn" onClick={() => copy(input.streamKey)}>
                  {t('liveCopy')}
                </button>
              </div>
              <p className="live-hint">{t('liveKeySecretNote')}</p>
              <button type="button" className="live-small-btn live-danger" onClick={() => setConfirmReset(true)} disabled={busy}>
                {t('liveResetKey')}
              </button>
            </div>

            <div className="panel">
              {/* Bez OBS: appka Kine do PC / Kine Clipper má tlačítko Vysílat a klíč si vezme sama.
                  Kroky pro OBS jsou pod otazníčkem - kdo je nepotřebuje, nemusí je číst. */}
              <PanelHeading
                icon="broadcast"
                title={t('liveGuideHeading')}
                help={
                  <ol className="live-guide">
                    <li>{t('liveGuideStep1')}</li>
                    <li>{t('liveGuideStep2')}</li>
                    <li>{t('liveGuideStep3')}</li>
                    <li>{t('liveGuideStep4')}</li>
                  </ol>
                }
              />
              <p className="live-hint live-guide-app">
                {t('liveGuideApp')}{' '}
                <Link href="/download">{t('liveGuideAppLink')}</Link>
              </p>
            </div>

            <div className="panel">
              <PanelHeading icon="film" title={t('liveRecordingsHeading')} help={t('liveRecordingsNote').replace('{days}', String(setup.recordingKeepDays ?? 30))} />
              {/* Jako YouTube: záznam se po skončení může zveřejnit sám - a na rozdíl od Twitche nikdy nezmizí. */}
              <label className="live-field" style={{ marginBottom: 10 }}>
                <span>{t('liveAfterStreamLabel')}</span>
                <select
                  value={setup.recordingVisibility ?? 'off'}
                  onChange={(e) => saveAfterStream(e.target.value)}
                  disabled={setup.recordingAutoSupported === false}
                >
                  <option value="off">{t('liveAfterStreamKeep')}</option>
                  <option value="public">{t('liveAfterStreamPublic')}</option>
                  <option value="subscribers">{t('liveAfterStreamSubscribers')}</option>
                  <option value="private">{t('liveAfterStreamPrivate')}</option>
                </select>
              </label>
              <p className="live-hint" style={{ marginTop: 0 }}>{t('liveAfterStreamHint')}</p>
              {recordings.length === 0 && <p className="live-hint">{t('liveRecordingsEmpty')}</p>}
              <div className="live-recordings">
                {recordings.map((r) => (
                  <div key={r.uid} className="live-recording">
                    <div className="live-recording-thumb">
                      {r.thumbnail ? <img src={r.thumbnail} alt="" loading="lazy" decoding="async" /> : null}
                      {r.duration ? <span className="live-recording-duration">{formatDuration(r.duration)}</span> : null}
                    </div>
                    <div className="live-recording-info">
                      <p className="live-recording-date">{r.created ? new Date(r.created).toLocaleString(DATE_LOCALES[lang]) : ''}</p>
                      {r.state === 'live-inprogress' && streamLive && !r.videoId ? (
                        <span className="live-pill">● {t('liveRecordingInProgress')}</span>
                      ) : r.videoId ? (
                        <Link href={`/watch/${r.videoId}`} className="live-studio-link">
                          <UiIcon name="check" size={14} /> {t('livePublished')} · {t('liveOpenVideo')} →
                        </Link>
                      ) : publishing?.uid === r.uid ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <input
                            type="text"
                            value={publishing.title}
                            maxLength={150}
                            onChange={(e) => setPublishing({ ...publishing, title: e.target.value })}
                            aria-label={t('videoTitle')}
                            style={{ flex: 1, minWidth: 180 }}
                          />
                          <select
                            value={publishing.visibility}
                            onChange={(e) => setPublishing({ ...publishing, visibility: e.target.value as 'public' | 'subscribers' | 'private' })}
                            aria-label={t('liveAfterStreamLabel')}
                          >
                            <option value="public">{t('liveVisibilityPublic')}</option>
                            <option value="subscribers">{t('liveVisibilitySubscribers')}</option>
                            <option value="private">{t('liveVisibilityPrivate')}</option>
                          </select>
                          <button type="button" onClick={publish} disabled={busy || !publishing.title.trim()}>
                            {t('livePublishRecording')}
                          </button>
                          <button type="button" className="live-small-btn" onClick={() => setPublishing(null)}>
                            {t('cancel')}
                          </button>
                        </div>
                      ) : (
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          {/* Po konci vysílání ho Cloudflare ještě minutu uzavírá / zpracovává - zveřejnit jde už teď. */}
                          {r.state === 'live-inprogress' ? (
                            <span className="live-hint">{t('liveRecordingFinishing')}</span>
                          ) : !r.readyToStream ? (
                            <span className="live-hint">{t('liveRecordingProcessing')}</span>
                          ) : null}
                          <button
                            type="button"
                            className="live-small-btn"
                            onClick={() =>
                              setPublishing({
                                uid: r.uid,
                                visibility: setup.recordingVisibility ?? 'public',
                                title:
                                  (stream?.title || '').trim() ||
                                  t('liveDefaultRecordingTitle').replace('{date}', r.created ? new Date(r.created).toLocaleDateString(DATE_LOCALES[lang]) : ''),
                              })
                            }
                          >
                            {t('livePublishRecording')}
                          </button>
                          {r.state !== 'live-inprogress' &&
                            (recDownload?.uid === r.uid ? (
                              recDownload.url ? (
                                <a href={recDownload.url} target="_blank" rel="noopener noreferrer" className="live-small-btn live-rec-save" onClick={() => setTimeout(() => setRecDownload(null), 500)}>
                                  <UiIcon name="download" size={13} /> {t('liveRecSaveFile')}
                                </a>
                              ) : (
                                <span className="live-hint">
                                  <span className="spin" aria-hidden="true" /> {t('liveRecPreparing').replace('{percent}', recDownload.percent === null ? '…' : `${recDownload.percent} %`)}
                                </span>
                              )
                            ) : (
                              <button type="button" className="live-small-btn" onClick={() => void downloadRecording(r.uid)} disabled={!!recDownload}>
                                <UiIcon name="download" size={13} /> {t('liveRecDownload')}
                              </button>
                            ))}
                          {recDiscard === r.uid ? (
                            <span className="live-rec-confirm">
                              {t('liveRecDiscardConfirm')}
                              <button type="button" className="live-small-btn live-rec-danger" onClick={() => void discardRecording(r.uid)} disabled={busy}>
                                {t('liveRecDiscard')}
                              </button>
                              <button type="button" className="live-small-btn" onClick={() => setRecDiscard(null)}>
                                {t('cancel')}
                              </button>
                            </span>
                          ) : (
                            !(r.state === 'live-inprogress' && streamLive) && (
                              <button type="button" className="live-small-btn live-rec-danger" onClick={() => setRecDiscard(r.uid)}>
                                <UiIcon name="trash" size={13} /> {t('liveRecDiscard')}
                              </button>
                            )
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Podpory ve vysílání: zapnutí, poslední podpory, překryv pro OBS se čtením nahlas. */}
            {CREATOR_PAYMENTS_ENABLED ? <LiveTipsPanel token={token} userId={userId} onCopy={copy} /> : <ComingSoon text={t('comingSoonTips')} />}

            <div className="panel">
              <PanelHeading icon="chat" title={t('liveChatToolsHeading')} help={t('liveChatObsOverlayHint')} />
              {/* Chat jako průhledný překryv do OBS (Zdroj prohlížeče). */}
              <div className="live-key-row">
                <span className="live-key-label">{t('liveChatObsOverlay')}</span>
                <code className="live-key-value">{`${typeof window !== 'undefined' ? window.location.origin : ''}/live/${userId}/chat?overlay=1`}</code>
                <button type="button" className="live-small-btn" onClick={() => copy(`${window.location.origin}/live/${userId}/chat?overlay=1`)}>
                  {t('liveCopy')}
                </button>
              </div>

              <WithHelp help={t('liveChatModeratorsHint')} className="live-moderators-head">
                <p className="panel-heading" style={{ margin: 0 }}>{t('liveChatModerators')}</p>
              </WithHelp>
              <form
                style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newModerator.trim()) changeModerators({ action: 'add', username: newModerator.trim() });
                }}
              >
                <input
                  type="text"
                  value={newModerator}
                  onChange={(e) => setNewModerator(e.target.value)}
                  placeholder={t('liveChatModeratorPlaceholder')}
                  aria-label={t('liveChatModeratorPlaceholder')}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <button type="submit" className="live-small-btn" disabled={!newModerator.trim()}>
                  {t('liveChatAddModerator')}
                </button>
              </form>
              {moderators.length === 0 ? (
                <p className="live-hint">{t('liveChatNoModerators')}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {moderators.map((m) => (
                    <div key={m.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span className="live-moderator-name">
                        <UiIcon name="shield" size={15} /> {m.username ?? '—'}
                      </span>
                      <button type="button" className="live-small-btn" onClick={() => changeModerators({ action: 'remove', userId: m.userId })}>
                        {t('liveChatRemoveModerator')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* Vlastní emoty kanálu (jdou i z nastavení chatu - ikonka posuvníků). */}
              <StudioEmotes room={channelRoom(userId)} />
            </div>
          </div>

          <LiveChat
            room={channelRoom(userId)}
            canModerate
            className="live-side"
            popoutHref={`/live/${userId}/chat`}
            since={stream?.chatSince ?? null}
            note={stream && !stream.live && stream.endedAt ? t('liveChatFreshOffline') : null}
          />
        </div>
      )}
    </div>
  );
}

/** Emoty kanálu ve studiu (stejná správa jako v nastavení chatu). */
function StudioEmotes({ room }: { room: string }) {
  const emotes = useChatEmotes(room);
  return <ChatEmoteManager room={room} emotes={emotes.channel} available={emotes.available} onChange={emotes.replace} />;
}
