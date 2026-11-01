import { supabaseServer } from './supabaseServer';
import {
  appPingFresh,
  appSignalTrusted,
  connectedFromInputStatus,
  decideLive,
  pingRevives,
  revivedStartedAt,
  sameStreamReturns,
  staleWithoutCloudflare,
  type LiveDecision,
} from './liveSignal';
import { autoPublishAfterStream } from './liveRecording';
import { chatSessionSince } from './liveChat';
import { logLiveEvent, secondsSince } from './liveEvents';
import { liveHiddenNow } from './nudityRules';
import { runInBackground } from './background';
import { insertedIds, pushNotificationsByIds } from './pushSend';
import { liveGameSlug } from './games';
import { takeReminders } from './liveScheduleServer';

export { appPingFresh, appSignalTrusted, APP_PING_FRESH_MS, APP_UNCONFIRMED_MAX_MS } from './liveSignal';

/**
 * Živé vysílání přes Cloudflare Stream Live.
 *
 * JAK TO FUNGUJE
 *
 * Každý kanál si jednou založí "vstup" (live input) - Cloudflare k němu dá
 * adresu serveru (RTMPS) a tajný klíč. Ty tvůrce vloží do OBS (nebo čehokoli,
 * co umí RTMP) a vysílá. Cloudflare vysílání rovnou přehrává divákům a zároveň
 * ho nahrává - po skončení z něj je obyčejné video, které jde na Kine
 * zveřejnit (/api/live/recordings).
 *
 * Kdo je zrovna živě, se zjišťuje jedním dotazem na Cloudflare pro všechny
 * kanály naráz (videa ve stavu "live-inprogress") - nejvýš jednou za
 * SYNC_THROTTLE_MS na instanci serveru. Volá se z míst, kam chodí diváci
 * (řada "Živě" na hlavní stránce, stav kanálu, stránka přenosu), takže
 * nepotřebuje webhook ani nastavování v Cloudflare. Při přechodu do živého
 * vysílání dostanou odběratelé oznámení (jednou za vysílání).
 */

export type LiveStreamRow = {
  owner_id: string;
  cf_input_id: string;
  title: string;
  description: string;
  category: string | null;
  is_live: boolean;
  current_video_uid: string | null;
  started_at: string | null;
  ended_at: string | null;
  checked_at: string | null;
  notified_video_uid: string | null;
  notified_at: string | null;
  /** Kdy naposledy appka (Kine Clipper) ohlásila, že vysílá. Sloupec je z migrace supabase-migration-live-app.sql. */
  app_ping_at?: string | null;
  /** Kdy přenos naposledy viděl Cloudflare. Sloupec je z migrace supabase-migration-bezpecnost-rijen.sql. */
  cf_confirmed_at?: string | null;
  /** Vlastní náhled přenosu (app/api/live/thumbnail). Sloupec je z migrace supabase-migration-zive-3.sql. */
  thumbnail_url?: string | null;
  /** Kdy appka řekla "skončil jsem" a který záznam tím skončil (migrace supabase-migration-zive-odznaky.sql). */
  app_stopped_at?: string | null;
  stopped_video_uid?: string | null;
  /** Poslední změna řádku (appka při každém hlášení) - srovnání podle ní pozná, že jeho údaje už neplatí. */
  updated_at?: string | null;
  /** Hra přenosu (lib/games.ts - slug). Sloupec je z migrace supabase-migration-push-hry-naklady.sql. */
  game?: string | null;
};

/** Nejvýš jednou za tolik se Cloudflare ptá, kdo vysílá. */
const SYNC_THROTTLE_MS = 12 * 1000;
/** Nový přenos do půl hodiny po posledním oznámení se odběratelům znovu nehlásí (výpadek, restart OBS). */
const RENOTIFY_AFTER_MS = 30 * 60 * 1000;

function cloudflare(): { accountId: string; token: string } | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_STREAM_API_TOKEN;
  return accountId && token ? { accountId, token } : null;
}

export function liveConfigured(): boolean {
  return !!cloudflare();
}

/** Kód zákazníka z adresy Cloudflare (customer-<kód>.cloudflarestream.com) - pro přehrávač přenosu. */
let customerCode: string | null = process.env.NEXT_PUBLIC_STREAM_CUSTOMER_CODE || null;

export function codeFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /customer-([a-z0-9]+)\.cloudflarestream\.com/i.exec(url);
  return m ? m[1] : null;
}

/** Kód zákazníka z videa od Cloudflare (náhled, náhledový přehrávač, HLS) - první, který se najde. */
export function codeFromCloudflareVideo(video: any): string | null {
  if (!video || typeof video !== 'object') return null;
  return codeFromUrl(video.thumbnail) ?? codeFromUrl(video.preview) ?? codeFromUrl(video.playback?.hls) ?? codeFromUrl(video.playback?.dash) ?? null;
}

/** Kdy se naposledy ptalo Cloudflare na kód - ať se to nezkouší při každém dotazu. */
let codeLookupAt = 0;

/**
 * Kód zákazníka: z nastavení (NEXT_PUBLIC_STREAM_CUSTOMER_CODE), z posledního
 * dotazu na Cloudflare, z náhledu videa v databázi, nebo přímo od Cloudflare
 * (každé video na účtu ho má v adrese náhledu). Bez kódu nejde přehrávač
 * vstupu ani HLS vstupu (appka podle něj hlídá, že diváci obraz vidí).
 */
export async function streamCustomerCode(): Promise<string | null> {
  if (customerCode) return customerCode;
  try {
    const { data } = await supabaseServer
      .from('videos')
      .select('thumbnail_url')
      .like('thumbnail_url', '%cloudflarestream.com%')
      .limit(1);
    const code = codeFromUrl(data?.[0]?.thumbnail_url);
    if (code) customerCode = code;
  } catch {
    // zkusí se Cloudflare
  }
  if (!customerCode && cloudflare() && Date.now() - codeLookupAt > 60 * 1000) {
    codeLookupAt = Date.now();
    try {
      const list = await Promise.race([cfFetch('?limit=3').catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500))]);
      for (const v of Array.isArray(list) ? list : []) {
        const code = codeFromCloudflareVideo(v);
        if (code) {
          customerCode = code;
          break;
        }
      }
    } catch {
      // Bez kódu se přehrávač přenosu vezme podle id videa (až ho Cloudflare potvrdí).
    }
  }
  return customerCode;
}

/**
 * Adresa přehrávače: vstup (hraje, co zrovna běží) na doméně zákazníka, jinak
 * přenos podle id videa. Bez obojího null - přehrávač podle id VSTUPU na
 * videodelivery.net není doložený (stránka místo něj ukáže "přenos začíná").
 */
export function livePlayerUrl(inputId: string, videoUid: string | null, code: string | null): string | null {
  if (code) return `https://customer-${code}.cloudflarestream.com/${inputId}/iframe?autoplay=true&letterboxColor=transparent`;
  return videoUid ? `https://iframe.videodelivery.net/${videoUid}?autoplay=true` : null;
}

/** HLS vstupu (totéž, co hraje přehrávač) - appka si podle něj ověří, že diváci obraz opravdu vidí. */
export function liveHlsUrl(inputId: string, code: string | null): string | null {
  if (!code || !/^[a-z0-9]+$/i.test(inputId)) return null;
  return `https://customer-${code}.cloudflarestream.com/${inputId}/manifest/video.m3u8`;
}

async function cfFetch(path: string, init: RequestInit = {}): Promise<any> {
  const cf = cloudflare();
  if (!cf) throw new Error('Cloudflare Stream není nastavený.');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/stream${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    cache: 'no-store',
    // Zaseknuté spojení nesmí zablokovat srovnání živých přenosů (a s ním odpovědi appce).
    signal: init.signal ?? AbortSignal.timeout(15 * 1000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const message = body?.errors?.[0]?.message ?? `Cloudflare odpověděl ${res.status}`;
    throw new Error(message);
  }
  return body.result;
}

export type CreatedInput = { uid: string; rtmpsUrl: string; streamKey: string; srtUrl: string | null };

/**
 * Založí vstup pro vysílání. Záznam se nahrává automaticky; krátký výpadek
 * (do minuty) se do jednoho záznamu slepí; nezveřejněné záznamy Cloudflare
 * po 30 dnech smaže (zveřejnění mazání zruší).
 */
export async function createLiveInput(name: string): Promise<CreatedInput> {
  const result = await cfFetch('/live_inputs', {
    method: 'POST',
    body: JSON.stringify({
      meta: { name: name.slice(0, 120) },
      recording: { mode: 'automatic', timeoutSeconds: 60 },
      deleteRecordingAfterDays: 30,
    }),
  });
  const rtmpsUrl = result?.rtmps?.url;
  const streamKey = result?.rtmps?.streamKey;
  if (!result?.uid || !rtmpsUrl || !streamKey) throw new Error('Cloudflare nevrátil adresu pro vysílání.');
  const srtUrl = result?.srt?.url && result?.srt?.streamId ? `${result.srt.url}?streamid=${result.srt.streamId}` : null;
  return { uid: result.uid, rtmpsUrl, streamKey, srtUrl };
}

export async function deleteLiveInput(uid: string): Promise<void> {
  try {
    await cfFetch(`/live_inputs/${uid}`, { method: 'DELETE' });
  } catch {
    // Vstup už u Cloudflare není (nebo se nepovedlo) - nový klíč se založí tak jako tak.
  }
}

export type LiveRecording = {
  uid: string;
  state: string;
  created: string | null;
  duration: number | null;
  thumbnail: string | null;
  readyToStream: boolean;
};

/** Záznamy vysílání jednoho vstupu (nejnovější první). Běžící přenos má state "live-inprogress". */
export async function listInputVideos(inputId: string): Promise<LiveRecording[]> {
  const result = await cfFetch(`/live_inputs/${inputId}/videos`);
  const list: any[] = Array.isArray(result) ? result : [];
  return list
    .map((v) => ({
      uid: String(v.uid),
      state: String(v.status?.state ?? v.state ?? ''),
      created: v.created ?? null,
      duration: typeof v.duration === 'number' && v.duration > 0 ? v.duration : null,
      thumbnail: v.thumbnail ?? null,
      readyToStream: !!v.readyToStream,
    }))
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

/** Zveřejněný záznam Cloudflare nesmaže (vstupy mají mazání nezveřejněných po 30 dnech). */
export async function keepRecording(uid: string): Promise<void> {
  try {
    await cfFetch(`/${uid}`, { method: 'POST', body: JSON.stringify({ scheduledDeletion: null }) });
  } catch {
    // Když to nejde, záznam zůstane s plánovaným smazáním - hlásí se v logu Vercelu.
    console.error('Kine: zrušení plánovaného smazání záznamu se nepovedlo', uid);
  }
}

/** Smaže video (záznam vysílání) u Cloudflare - nejde vrátit. */
export async function deleteCloudflareVideo(uid: string): Promise<void> {
  await cfFetch(`/${uid}`, { method: 'DELETE' });
}

export type CloudflareDownload = { status: 'ready' | 'inprogress' | 'error'; url: string | null; percent: number | null };

/**
 * MP4 ke stažení: první požadavek ho u Cloudflare nechá vyrobit (u hodinového
 * záznamu to trvá i pár minut), další jen zjistí, jak daleko je.
 */
export async function requestCloudflareDownload(uid: string): Promise<CloudflareDownload> {
  const result = await cfFetch(`/${uid}/downloads`, { method: 'POST' });
  const mp4 = result?.default ?? null;
  const status = mp4?.status === 'ready' ? 'ready' : mp4?.status === 'error' ? 'error' : 'inprogress';
  const percent = typeof mp4?.percentComplete === 'number' ? Math.max(0, Math.min(100, mp4.percentComplete)) : null;
  return { status, url: typeof mp4?.url === 'string' ? mp4.url : null, percent };
}

/** Údaje o jednom videu u Cloudflare (délka, náhled, rozměry, připravenost). */
export async function cloudflareVideo(uid: string): Promise<any | null> {
  try {
    return await cfFetch(`/${uid}`);
  } catch {
    return null;
  }
}

// ---- kdo je živě --------------------------------------------------------------------

let lastSyncAt = 0;
let syncing: Promise<void> | null = null;

export type InputLifecycle = { live: boolean; videoUid: string | null };

/** Odpovědi lifecycle si server pamatuje pár vteřin (souběžná srovnání se neptají dvakrát). */
const LIFECYCLE_TTL_MS = 5 * 1000;
const lifecycleCache = new Map<string, { at: number; value: InputLifecycle | null }>();

/**
 * Přijímá vstup právě vysílání? Ptá se lifecycle vstupu
 * (customer-<kód>.cloudflarestream.com/<vstup>/lifecycle) - podle toho
 * se řídí i přehrávač Cloudflare, když ukazuje "vysílání nezačalo".
 * null = nejde zjistit (pak rozhoduje jen seznam běžících přenosů).
 */
export async function inputLifecycle(inputId: string): Promise<InputLifecycle | null> {
  const hit = lifecycleCache.get(inputId);
  if (hit && Date.now() - hit.at < LIFECYCLE_TTL_MS) return hit.value;
  const code = await streamCustomerCode();
  const cf = cloudflare();
  if (!code || !cf || !/^[a-z0-9]+$/i.test(inputId)) return null;
  let value: InputLifecycle | null = null;
  try {
    // Lifecycle je veřejná adresa (ptá se jí i přehrávač) - API klíč se k ní neposílá; jen když
    // by ji Cloudflare bez něj odmítl (dřív se posílal vždycky a odpověď pak mohla chybět).
    const url = `https://customer-${code}.cloudflarestream.com/${inputId}/lifecycle`;
    let res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${cf.token}` }, cache: 'no-store', signal: AbortSignal.timeout(2500) });
    }
    if (!res.ok) console.info(`Kine živě: lifecycle vstupu ${inputId} odpověděl ${res.status}`);
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (body && body.isInput === true && typeof body.live === 'boolean') {
      value = { live: body.live, videoUid: typeof body.videoUID === 'string' && body.videoUID ? body.videoUID : null };
    }
  } catch {
    value = null;
  }
  lifecycleCache.set(inputId, { at: Date.now(), value });
  if (lifecycleCache.size > 500) {
    for (const [key, entry] of lifecycleCache) if (Date.now() - entry.at > LIFECYCLE_TTL_MS) lifecycleCache.delete(key);
  }
  return value;
}

/** Běžící záznam vstupu ze seznamu jeho videí: undefined = nejde zjistit, null = žádný neběží. */
export type InputLiveVideo = { uid: string; created: string | null } | null | undefined;
const inputVideoCache = new Map<string, { at: number; value: InputLiveVideo }>();

/**
 * Běžící záznam (live-inprogress) ze seznamu videí vstupu. Seznam běžících
 * přenosů celého účtu (?status=live-inprogress) občas vysílání vůbec
 * neobsahoval - a Kine pak přenos, který Cloudflare vysílal a appka hlásila
 * "diváci tě vidí", po 3 minutách stáhla ("nikdo nevysílá"). Seznam videí
 * vstupu je ten samý, podle kterého jde záznam zahodit.
 */
export async function liveVideoOfInput(inputId: string): Promise<InputLiveVideo> {
  if (!/^[a-z0-9]+$/i.test(inputId)) return undefined;
  const hit = inputVideoCache.get(inputId);
  if (hit && Date.now() - hit.at < LIFECYCLE_TTL_MS) return hit.value;
  let value: InputLiveVideo = undefined;
  try {
    const recs = await Promise.race([listInputVideos(inputId).catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500))]);
    if (recs) {
      const live = recs.find((r) => r.state === 'live-inprogress');
      value = live ? { uid: live.uid, created: live.created } : null;
    }
  } catch {
    value = undefined;
  }
  inputVideoCache.set(inputId, { at: Date.now(), value });
  if (inputVideoCache.size > 500) {
    for (const [key, entry] of inputVideoCache) if (Date.now() - entry.at > LIFECYCLE_TTL_MS) inputVideoCache.delete(key);
  }
  return value;
}

const hlsCache = new Map<string, { at: number; value: boolean | null }>();

/** Text playlistu HLS (nejvýš 200 kB); null = nejde. */
async function fetchPlaylist(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    const text = res.ok ? (await res.text()).slice(0, 200_000) : '';
    return { status: res.status, text };
  } catch {
    return null;
  }
}

/**
 * Běží HLS vstupu u Cloudflare (customer-<kód>.cloudflarestream.com/<vstup>/manifest/video.m3u8)?
 * Totéž čte přehrávač diváka i appka ("diváci tě vidí"). true = mediální playlist
 * s kousky a bez konce (#EXT-X-ENDLIST), false = playlist není / skončil, null = nevíme.
 */
export async function inputHlsLive(inputId: string): Promise<boolean | null> {
  if (!/^[a-z0-9]+$/i.test(inputId)) return null;
  const hit = hlsCache.get(inputId);
  if (hit && Date.now() - hit.at < LIFECYCLE_TTL_MS) return hit.value;
  const code = await streamCustomerCode();
  let value: boolean | null = null;
  if (code) {
    const masterUrl = `https://customer-${code}.cloudflarestream.com/${inputId}/manifest/video.m3u8`;
    const master = await fetchPlaylist(masterUrl);
    if (master && (master.status === 404 || master.status === 410 || master.status === 204)) value = false;
    else if (master && master.status === 200 && master.text.trimStart().startsWith('#EXTM3U')) {
      let media = master.text;
      if (/#EXT-X-STREAM-INF/i.test(media)) {
        const lines = media.split(/\r?\n/).map((l) => l.trim());
        const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
        const uri = idx >= 0 ? lines.slice(idx + 1).find((l) => l && !l.startsWith('#')) : undefined;
        let variant: string | null = null;
        try {
          variant = uri ? new URL(uri, masterUrl).toString() : null;
        } catch {
          variant = null;
        }
        const got = variant ? await fetchPlaylist(variant) : null;
        media = got && got.status === 200 ? got.text : '';
      }
      if (media.includes('#EXT-X-ENDLIST')) value = false;
      else if (/#EXTINF/i.test(media)) value = true;
    }
  }
  hlsCache.set(inputId, { at: Date.now(), value });
  if (hlsCache.size > 500) {
    for (const [key, entry] of hlsCache) if (Date.now() - entry.at > LIFECYCLE_TTL_MS) hlsCache.delete(key);
  }
  return value;
}

/** Co o vstupu naposledy řekl Cloudflare (pro odpověď appce - ta to zapíše do deníku a ukáže). */
export type InputEvidence = { lifecycle: boolean | null; listed: boolean; hls: boolean | null; videoUid: string | null; at: number };
const lastEvidence = new Map<string, InputEvidence>();

function rememberEvidence(inputId: string, evidence: Omit<InputEvidence, 'at'>): void {
  lastEvidence.set(inputId, { ...evidence, at: Date.now() });
  if (lastEvidence.size > 500) {
    for (const [key, entry] of lastEvidence) if (Date.now() - entry.at > 10 * 60 * 1000) lastEvidence.delete(key);
  }
}

/** Stav vstupu z API (záloha za lifecycle) - pár vteřin v paměti jako lifecycle. */
const inputStatusCache = new Map<string, { at: number; value: boolean | null }>();

async function inputStatusFromApi(inputId: string): Promise<boolean | null> {
  const hit = inputStatusCache.get(inputId);
  if (hit && Date.now() - hit.at < LIFECYCLE_TTL_MS) return hit.value;
  let value: boolean | null = null;
  try {
    const result = await Promise.race([
      cfFetch(`/live_inputs/${encodeURIComponent(inputId)}`).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    value = result ? connectedFromInputStatus((result as any).status) : null;
  } catch {
    value = null;
  }
  inputStatusCache.set(inputId, { at: Date.now(), value });
  if (inputStatusCache.size > 500) {
    for (const [key, entry] of inputStatusCache) if (Date.now() - entry.at > LIFECYCLE_TTL_MS) inputStatusCache.delete(key);
  }
  return value;
}

/**
 * Vysílá vstup? Lifecycle (to samé, podle čeho se řídí přehrávač), a když
 * nejde zjistit, stav vstupu z API. live null = nevíme - pak rozhoduje
 * seznam běžících přenosů (lib/liveSignal.ts, decideLive).
 */
export async function inputSeen(inputId: string): Promise<{ live: boolean | null; videoUid: string | null }> {
  const life = await inputLifecycle(inputId);
  if (life) return life;
  if (!/^[a-z0-9]+$/i.test(inputId)) return { live: null, videoUid: null };
  return { live: await inputStatusFromApi(inputId), videoUid: null };
}

/**
 * Co Cloudflare právě vysílá (seznam běžících přenosů celého účtu) - pro
 * diagnostiku na /admin/live. Na rozdíl od srovnání (syncLiveStreams) nic
 * nemění, jen čte.
 */
export async function cloudflareLiveListing(): Promise<{ ok: boolean; error: string | null; byInput: Map<string, { uid: string; created: string | null }> }> {
  const byInput = new Map<string, { uid: string; created: string | null }>();
  if (!cloudflare()) return { ok: false, error: 'Cloudflare Stream není na serveru nastavený (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_STREAM_API_TOKEN).', byInput };
  try {
    const result = await cfFetch('?status=live-inprogress&asc=false');
    for (const v of Array.isArray(result) ? result : []) {
      if (String(v.status?.state ?? v.state ?? '') !== 'live-inprogress' || !v.liveInput) continue;
      if (!byInput.has(v.liveInput)) byInput.set(v.liveInput, { uid: String(v.uid), created: v.created ?? null });
    }
    return { ok: true, error: null, byInput };
  } catch (e) {
    return { ok: false, error: (e as Error).message, byInput };
  }
}

/**
 * Odvysílaný čas do profilu (odznak Hodiny živě - lib/badges.ts). Jen přenos,
 * který Cloudflare v tomhle vysílání opravdu viděl (žádné "vysílání" bez
 * jediného snímku). Bez migrace posty-ankety funkce chybí - nic se nestane.
 */
async function addLiveSeconds(row: LiveStreamRow, endIso: string): Promise<void> {
  const started = row.started_at ? Date.parse(row.started_at) : NaN;
  const confirmed = Date.parse((row.cf_confirmed_at ?? row.checked_at ?? '') as string);
  const end = Date.parse(endIso);
  if (!Number.isFinite(started) || !Number.isFinite(end) || !Number.isFinite(confirmed) || confirmed < started) return;
  const seconds = Math.round((Math.min(end, confirmed + 90 * 1000) - started) / 1000);
  if (seconds <= 0) return;
  try {
    await supabaseServer.rpc('add_live_seconds', { p_user: row.owner_id, p_seconds: Math.min(seconds, 24 * 3600) });
  } catch {
    // počítadlo není nutné pro vysílání
  }
}

/**
 * Ukončí přenos v databázi (a zveřejní záznam, když si to tvůrce zapnul). Jen když
 * se řádek od přečtení nezměnil: srovnání čte stav, pak se pár vteřin ptá Cloudflare -
 * a mezitím appka třeba právě nahlásila "začal jsem / pořád vysílám". Dřív pak
 * srovnání se starými údaji živý přenos ukončilo ("Živě" ho chvíli neukazovalo).
 * Vrací, jestli se přenos opravdu ukončil.
 */
async function endStream(row: LiveStreamRow, nowIso: string): Promise<boolean> {
  // Čerstvé hlášení, kterému se už nevěří (Cloudflare přenos dlouho nevidí):
  // smazat ho, ať ho další "pořád vysílám" neoživí - znovu jen "začal jsem".
  let query = supabaseServer
    .from('live_streams')
    .update({ is_live: false, ended_at: nowIso, checked_at: nowIso, updated_at: nowIso, ...(appPingFresh(row) ? { app_ping_at: null } : {}) })
    .eq('owner_id', row.owner_id)
    .eq('is_live', true);
  if (row.updated_at) query = query.eq('updated_at', row.updated_at);
  const { data, error } = await query.select('owner_id');
  if (error || !data || data.length === 0) return false;
  await addLiveSeconds(row, nowIso);
  // Vysílání skončilo (OBS, nebo appka bez rozloučení): záznam se zveřejní sám, když si to tvůrce zapnul.
  await autoPublishAfterStream(row.owner_id);
  return true;
}

/** Co srovnání naposledy rozhodlo o kanálu (diagnostika pro tým Kine na stránce Živě) - jen tahle instance serveru. */
export type LiveDecisionNote = {
  at: string;
  decision: LiveDecision;
  /** Konec bez odpovědi Cloudflare (CF_SILENT_MAX_MS). */
  silent: boolean;
  /** Zápis se nepovedl, protože se řádek mezitím změnil (appka zrovna hlásila) - nevadí, další srovnání. */
  skipped: boolean;
  evidence: { lifecycle: boolean | null; listed: boolean; hls: boolean | null; videoUid: string | null };
};
const decisionNotes = new Map<string, LiveDecisionNote>();

export function liveDecisionNote(ownerId: string): LiveDecisionNote | null {
  return decisionNotes.get(ownerId) ?? null;
}

/** Poslední srovnání s Cloudflare na téhle instanci serveru (diagnostika). */
export type LiveSyncInfo = { at: string; listingOk: boolean; listed: number; rows: number; error: string | null };
let lastSyncInfo: LiveSyncInfo | null = null;

export function liveSyncInfo(): LiveSyncInfo | null {
  return lastSyncInfo;
}

/** Kdy přenos naposledy potvrdil Cloudflare (sloupec cf_confirmed_at, bez migrace checked_at). */
function lastConfirmedIso(row: LiveStreamRow): string | null {
  return row.cf_confirmed_at !== undefined ? row.cf_confirmed_at ?? null : row.checked_at;
}

/**
 * Srovná stav živých vysílání s Cloudflare. Nikdy nehodí chybu (volá se
 * z odpovědí divákům); nejvýš jednou za SYNC_THROTTLE_MS, souběžná volání
 * počkají na jedno.
 *
 * Kdo je živě, rozhoduje lib/liveSignal.ts (decideLive): seznam běžících
 * přenosů od Cloudflare, lifecycle vstupu (opravdu přijímá vysílání?),
 * seznam videí vstupu, HLS vstupu a hlášení z appky. Když Cloudflare
 * neodpovídá vůbec, živý přenos skončí až po CF_SILENT_MAX_MS bez
 * potvrzení (staleWithoutCloudflare).
 */
export async function syncLiveStreams(options: { force?: boolean } = {}): Promise<void> {
  if (!cloudflare()) return;
  const now = Date.now();
  if (!options.force && now - lastSyncAt < SYNC_THROTTLE_MS) return;
  if (syncing) return syncing;
  lastSyncAt = now;
  syncing = (async () => {
    let running: any[] = [];
    // Seznam běžících přenosů celého účtu nešel načíst: živé přenosy se srovnají aspoň podle
    // jejich vstupů (lifecycle, seznam videí vstupu, HLS). Dřív se pak nepotvrdilo nic,
    // přenos po 10 minutách zmizel a "pořád vysílám" z appky ho vracel - "Živě" blikalo.
    let listingFailed = false;
    let listingError: string | null = null;
    try {
      // Všechno, co u Cloudflare právě běží živě (jedním dotazem pro celý účet).
      const result = await cfFetch('?status=live-inprogress&asc=false');
      running = (Array.isArray(result) ? result : []).filter(
        (v) => String(v.status?.state ?? v.state ?? '') === 'live-inprogress' && v.liveInput
      );
    } catch (e) {
      listingFailed = true;
      listingError = (e as Error).message;
      console.error('Kine: Cloudflare neřekl, kdo vysílá (seznam běžících přenosů)', listingError);
    }
    try {
      for (const v of running) {
        const code = codeFromUrl(v.playback?.hls) ?? codeFromUrl(v.thumbnail);
        if (code) customerCode = code;
      }
      const liveInputs = new Map<string, any>();
      for (const v of running) if (!liveInputs.has(v.liveInput)) liveInputs.set(v.liveInput, v);

      const { data } = await supabaseServer
        .from('live_streams')
        .select('*')
        .or(`is_live.eq.true${liveInputs.size > 0 ? `,cf_input_id.in.(${[...liveInputs.keys()].map((id) => `"${id}"`).join(',')})` : ''}`);
      const rows = (data ?? []) as LiveStreamRow[];
      lastSyncInfo = { at: new Date().toISOString(), listingOk: !listingFailed, listed: liveInputs.size, rows: rows.length, error: listingError };

      // Opravdu vysílají? Vstupy, které Cloudflare hlásí jako běžící, i živé přenosy,
      // které v seznamu zrovna chybí (seznam občas běžící přenos vynechá) - souběžně.
      // Živý přenos, který v seznamu celého účtu chybí, se hledá i v seznamu videí jeho
      // vstupu, a když appka hlásí vysílání a nic jiného ho nepotvrdí, i v HLS vstupu
      // (to samé čte divák) - jeden zdroj, který mlčí, přenos z "Živě" nesmí stáhnout.
      const gathered = new Map<
        string,
        {
          life: { live: boolean | null; videoUid: string | null } | null;
          video: { uid: string; created: string | null } | null;
          /** Seznam videí vstupu (nebo seznam účtu) odpověděl - "žádný běžící záznam" je pak jisté. */
          videoKnown: boolean;
          hls: boolean | null;
        }
      >();
      await Promise.all(
        rows
          .filter((row) => liveInputs.has(row.cf_input_id) || row.is_live)
          .map(async (row) => {
            const listed = liveInputs.get(row.cf_input_id);
            const [life, own] = await Promise.all([
              inputSeen(row.cf_input_id),
              !listed && row.is_live ? liveVideoOfInput(row.cf_input_id) : Promise.resolve(undefined),
            ]);
            const video = listed ? { uid: String(listed.uid), created: listed.created ?? null } : own ?? null;
            const videoKnown = !!listed || own !== undefined;
            const hls = row.is_live && appPingFresh(row) && !video && life?.live !== true ? await inputHlsLive(row.cf_input_id) : null;
            gathered.set(row.cf_input_id, { life, video, videoKnown, hls });
            rememberEvidence(row.cf_input_id, { lifecycle: life ? life.live : null, listed: !!video, hls, videoUid: life?.videoUid ?? video?.uid ?? null });
          })
      );

      const nowIso = new Date().toISOString();
      for (const row of rows) {
        const found = gathered.get(row.cf_input_id);
        const video = found?.video ?? null;
        const life = found?.life ?? null;
        let decision = decideLive(row, {
          listed: !!video,
          connected: life ? life.live : null,
          videoCreatedAt: video?.created ?? null,
          videoUid: life?.videoUid ?? video?.uid ?? null,
          hls: found?.hls ?? null,
        });
        // Bez seznamu účtu konec jen podle jisté odpovědi o vstupu (lifecycle "nevysílá", seznam
        // videí vstupu bez běžícího záznamu, skončený HLS). Když Cloudflare neodpovídá vůbec,
        // přenos skončí až po CF_SILENT_MAX_MS bez potvrzení (lib/liveSignal.ts).
        const silent = listingFailed && decision === 'end' && life?.live !== false && !found?.videoKnown && found?.hls !== false;
        if (silent && !staleWithoutCloudflare(row)) decision = 'keep';
        const note: LiveDecisionNote = {
          at: nowIso,
          decision,
          silent,
          skipped: false,
          evidence: { lifecycle: life ? life.live : null, listed: !!video, hls: found?.hls ?? null, videoUid: life?.videoUid ?? video?.uid ?? null },
        };
        decisionNotes.set(row.owner_id, note);
        if (decisionNotes.size > 500) {
          for (const [key, value] of decisionNotes) if (Date.now() - Date.parse(value.at) > 30 * 60 * 1000) decisionNotes.delete(key);
        }
        if (decision === 'confirm') {
          const lifeUid = life?.live && life.videoUid ? life.videoUid : null;
          // Návrat téhož přenosu (stejný záznam u Cloudflare): začátek zůstává - čas vysílání
          // i chat jedou dál. Nový přenos začíná, kdy ho Cloudflare založil (lib/liveSignal.ts).
          const resumed = sameStreamReturns(row, { lifeUid, videoCreatedAt: video?.created ?? null });
          // Běžící video podle lifecycle (to, co hraje přehrávač), jinak první ze seznamu; jinak
          // to, co už je u přenosu - ale jen u téhož přenosu (nový nesmí ukazovat starý záznam).
          const uid = lifeUid || (video ? video.uid : null) || (row.is_live || resumed ? row.current_video_uid ?? null : null);
          // Čas potvrzení od Cloudflare (jen když už sloupec v databázi je).
          const confirmedNow = Object.prototype.hasOwnProperty.call(row, 'cf_confirmed_at') ? { cf_confirmed_at: nowIso } : {};
          if (!row.is_live || row.current_video_uid !== uid) {
            // Skončený přenos oživí jen řádek, který se od přečtení nezměnil (mezitím mohl přijít
            // Ukončit z appky); živému se jen doplní video - když mezitím neskončil.
            let query = supabaseServer
              .from('live_streams')
              .update({
                is_live: true,
                current_video_uid: uid,
                started_at: (row.is_live || resumed) && row.started_at ? row.started_at : video?.created ?? nowIso,
                ended_at: null,
                checked_at: nowIso,
                ...confirmedNow,
                updated_at: nowIso,
              })
              .eq('owner_id', row.owner_id)
              .eq('is_live', row.is_live);
            if (!row.is_live && row.updated_at) query = query.eq('updated_at', row.updated_at);
            const { data: applied, error: applyError } = await query.select('owner_id');
            if (applyError || !applied || applied.length === 0) {
              note.skipped = true;
            } else {
              if (!row.is_live) {
                logLiveEvent(row.owner_id, 'confirm', resumed ? 'zase živě - Cloudflare vidí tentýž přenos' : 'živě - Cloudflare potvrdil vysílání', {
                  'lifecycle (přijímá vysílání)': life ? life.live : 'nejde zjistit',
                  'v seznamu běžících': !!video,
                  'video': uid,
                  'konec minulého (s)': secondsSince(row.ended_at),
                  'appka hlásila (s)': secondsSince(row.app_ping_at),
                });
              }
              if (uid) await notifyGoingLive(row, uid);
            }
          } else {
            await supabaseServer.from('live_streams').update({ checked_at: nowIso, ...confirmedNow }).eq('owner_id', row.owner_id).eq('is_live', true);
          }
        } else if (decision === 'keep') {
          // Appka hlásí, že vysílá (Cloudflare to jen ještě nepotvrdil), nebo se vstup právě
          // připojuje znovu. checked_at se tu nemění: drží čas posledního potvrzení od Cloudflare.
          if (!video && row.current_video_uid) {
            // Přenos, který Cloudflare před chvílí potvrdil, teď nevidí - do deníku (proč pak zmizel / nezmizel).
            logLiveEvent(row.owner_id, 'unseen', 'Cloudflare přenos teď nevidí - zatím se drží (appka hlásí / krátký výpadek)', {
              'lifecycle (přijímá vysílání)': life ? life.live : 'nejde zjistit',
              'v seznamu běžících': false,
              'appka hlásila (s)': secondsSince(row.app_ping_at),
              'appce se věří': appSignalTrusted(row),
              'Cloudflare naposledy potvrdil (s)': secondsSince(lastConfirmedIso(row)),
            });
            await supabaseServer.from('live_streams').update({ current_video_uid: null }).eq('owner_id', row.owner_id).eq('is_live', true);
          }
        } else if (decision === 'end') {
          const ended = await endStream(row, nowIso);
          if (!ended) {
            // Appka mezitím nahlásila vysílání (řádek se změnil): o konci rozhodne až další srovnání s čerstvými údaji.
            note.skipped = true;
          } else if (silent) {
            logLiveEvent(row.owner_id, 'silent-end', 'ukončeno - Cloudflare dlouho neodpovídá a appka o přenosu nehlásí', {
              'Cloudflare naposledy potvrdil (s)': secondsSince(lastConfirmedIso(row)),
              'appka naposledy hlásila (s)': secondsSince(row.app_ping_at),
              'začátek (s)': secondsSince(row.started_at),
            });
          } else {
            logLiveEvent(row.owner_id, 'end', 'ukončeno - Cloudflare přenos nevidí', {
              'lifecycle (přijímá vysílání)': life ? life.live : 'nejde zjistit',
              'v seznamu běžících': !!video,
              'HLS vstupu': found?.hls ?? 'neptáno',
              'appka hlásila (s)': secondsSince(row.app_ping_at),
              'appce se věří': appSignalTrusted(row),
              'Cloudflare naposledy potvrdil (s)': secondsSince(lastConfirmedIso(row)),
              'začátek (s)': secondsSince(row.started_at),
            });
          }
        }
      }
    } catch (e) {
      // Cloudflare nebo databáze zrovna nejde - zkusí se to při dalším dotazu.
      console.error('Kine: stav živých vysílání se nepodařilo srovnat', (e as Error).message);
    }
  })();
  try {
    await syncing;
  } finally {
    syncing = null;
  }
}

/**
 * Co o přenosu kanálu teď říká Cloudflare a co by s ním srovnání udělalo (diagnostika
 * na stránce Živě pro tým Kine). Nic nemění - jen se zeptá (lifecycle, seznam videí
 * vstupu, HLS) a spočítá rozhodnutí.
 */
export async function diagnoseLiveRow(row: LiveStreamRow): Promise<{
  evidence: { lifecycle: boolean | null; listed: boolean; hls: boolean | null; videoUid: string | null };
  wouldDecide: LiveDecision;
  appPingFresh: boolean;
  appTrusted: boolean;
}> {
  const [life, video, hls] = await Promise.all([
    inputSeen(row.cf_input_id).catch(() => ({ live: null, videoUid: null })),
    liveVideoOfInput(row.cf_input_id).catch(() => undefined),
    inputHlsLive(row.cf_input_id).catch(() => null),
  ]);
  const seen = { listed: !!video, connected: life.live, videoCreatedAt: video?.created ?? null, videoUid: life.videoUid ?? video?.uid ?? null, hls };
  return {
    evidence: { lifecycle: life.live, listed: !!video, hls, videoUid: seen.videoUid },
    wouldDecide: decideLive(row, seen),
    appPingFresh: appPingFresh(row),
    appTrusted: appSignalTrusted(row),
  };
}

/** Nejdéle tolik čeká odpověď divákovi na srovnání s Cloudflare; zbytek doběhne na pozadí. */
export const VIEWER_SYNC_BUDGET_MS = 1200;

/**
 * Seznamy přenosů (řada Živě, stránka Živě) na srovnání skoro nečekají: stav v databázi
 * drží čerstvý appka (hlásí se každých 15 s) a srovnání na pozadí - další obnovení
 * seznamu (za 20 s) už ukáže výsledek. Dřív se čekalo až 1,2 s při každém obnovení.
 */
export const LIST_SYNC_BUDGET_MS = 250;

/**
 * Srovnání s Cloudflare pro odpovědi divákům (řada Živě, stránka přenosu):
 * nejvýš VIEWER_SYNC_BUDGET_MS čekání. Dotazy na Cloudflare (seznam běžících,
 * lifecycle vstupů) trvaly někdy i několik vteřin - a celou tu dobu se
 * divákovi nic neukázalo (na hlavní stránce řada Živě chyběla, než
 * odpověď přišla). Stav v databázi drží čerstvý hlavně appka (hlásí se
 * každých 15 s a srovnání spouští sama); srovnání, které se do limitu
 * nevejde, doběhne na pozadí a projeví se při dalším obnovení (do 20 s).
 */
export async function syncLiveStreamsForViewers(budgetMs: number = VIEWER_SYNC_BUDGET_MS): Promise<void> {
  const run = syncLiveStreams();
  runInBackground(run, 'srovnání živých vysílání');
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, budgetMs)))]);
  if (timer) clearTimeout(timer);
}

/**
 * Kolik lidí přenos právě sleduje (Cloudflare: GET customer-<kód>.cloudflarestream.com/<vstup>/views).
 * Null, když to nejde zjistit - nikdy nečeká déle než 2 s.
 */
export async function liveViewerCount(inputId: string): Promise<number | null> {
  const code = await streamCustomerCode();
  if (!code || !/^[a-z0-9]+$/i.test(inputId)) return null;
  try {
    const res = await fetch(`https://customer-${code}.cloudflarestream.com/${inputId}/views`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const n = body?.liveViewers;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

/** Sloupce live_streams z pozdějších migrací - bez nich se zapisuje bez nich. */
const OPTIONAL_LIVE_COLUMNS = ['app_ping_at', 'app_stopped_at', 'stopped_video_uid'];

/** Které z volitelných sloupců zápis shodil (chybějící sloupec); [] = jiná chyba. */
export function optionalColumnsToDrop(error: { message?: string; code?: string } | null, patch: Record<string, unknown>): string[] {
  if (!error) return [];
  const present = OPTIONAL_LIVE_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch, c));
  const named = present.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(error.message ?? ''));
  if (named.length > 0) return named;
  // Neznámý sloupec bez jména v hlášce: pryč se všemi volitelnými (zbytek se zapíše).
  return error.code === '42703' || error.code === 'PGRST204' ? present : [];
}

/**
 * Hlášení z appky: "začal jsem vysílat" / "pořád vysílám" / "skončil jsem".
 * Vysílání se podle toho ukáže jako živé hned (Cloudflare ho potvrdí až za
 * pár vteřin, někdy déle) a `confirmed` řekne appce, jestli ho Cloudflare
 * opravdu vidí; `viewers` kolik lidí se dívá. Vrací null, když kanál nemá
 * založený klíč.
 *
 * Pojistky proti "falešnému živě": oznámení odběratelům jde až po potvrzení
 * od Cloudflare (syncLiveStreams), samotné "pořád vysílám" neoživí ukončený
 * přenos a přenos, který Cloudflare neviděl APP_UNCONFIRMED_MAX_MS, se ukončí.
 */
export async function appLiveSignal(
  ownerId: string,
  action: 'started' | 'ping' | 'stopped'
): Promise<{
  confirmed: boolean;
  migrated: boolean;
  viewers: number | null;
  /** Po "skončil jsem": záznam zveřejněný automaticky (nastavení tvůrce), jinak null. */
  recording?: { videoId: string; status: 'ready' | 'processing' } | null;
  /**
   * Po "skončil jsem": id záznamu PRÁVĚ skončeného vysílání u Cloudflare - appka ho
   * drží na kartě, ať "Stáhnout" a "Zahodit" míří na něj, ne na "nejnovější" (mezitím
   * mohlo začít jiné vysílání třeba z OBS).
   */
  recordingUid?: string | null;
  /** Přenos běží, ale kontrola obsahu ho skryla z "Živě" (čeká na moderátora) - appka to má říct, ne hlásit "vše v pořádku". */
  hidden?: boolean;
  /** Je přenos teď na Kine živě (řada Živě, stránka přenosu)? Appka to ukáže vedle "diváci tě vidí". */
  live?: boolean;
  /** Co o vstupu naposledy řekl Cloudflare (appka si to zapíše do deníku - diagnostika bez stránky správce). */
  cloudflare?: { lifecycle: boolean | null; listed: boolean; hls: boolean | null } | null;
} | null> {
  const { data } = await supabaseServer.from('live_streams').select('*').eq('owner_id', ownerId).maybeSingle();
  if (!data) return null;
  const row = data as LiveStreamRow;
  const nowIso = new Date().toISOString();
  // Bez migrace (sloupec app_ping_at chybí) funguje všechno postaru - stav jen podle Cloudflare.
  let migrated = Object.prototype.hasOwnProperty.call(row, 'app_ping_at');

  /**
   * Zápis stavu. Sloupce z novějších migrací (hlášení z appky, Ukončit v appce) můžou
   * chybět - pak se zapíše zbytek (stav jen podle Cloudflare, jako dřív).
   */
  async function write(patch: Record<string, unknown>): Promise<void> {
    let current: Record<string, unknown> = { ...patch };
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await supabaseServer.from('live_streams').update(current).eq('owner_id', ownerId);
      if (!error) return;
      const drop = optionalColumnsToDrop(error, current);
      if (drop.length === 0) return;
      // Migrace s hlášením z appky ještě není pustěná.
      if (drop.includes('app_ping_at')) migrated = false;
      current = Object.fromEntries(Object.entries(current).filter(([key]) => !drop.includes(key)));
    }
  }

  const stopPatch = {
    app_ping_at: null,
    is_live: false,
    current_video_uid: null,
    checked_at: nowIso,
    updated_at: nowIso,
  };

  if (action === 'stopped') {
    if (row.is_live) logLiveEvent(ownerId, 'stop', 'ukončeno v appce (Ukončit)', { 'začátek (s)': secondsSince(row.started_at) });
    // Který záznam patří k tomuhle vysílání: video, které Cloudflare právě nahrával; když ho
    // Kine nemá (Cloudflare přenos nepotvrdil), co hlásí lifecycle vstupu, a nakonec
    // nejnovější záznam od začátku vysílání.
    let recordingUid: string | null = row.current_video_uid ?? null;
    if (!recordingUid && row.cf_input_id) {
      const life = await inputLifecycle(row.cf_input_id).catch(() => null);
      if (life?.videoUid) recordingUid = life.videoUid;
    }
    if (!recordingUid && row.cf_input_id && row.started_at) {
      try {
        const since = Date.parse(row.started_at) - 2 * 60 * 1000;
        const recs = await listInputVideos(row.cf_input_id);
        recordingUid = recs.find((r) => r.created && Date.parse(r.created) >= since)?.uid ?? null;
      } catch {
        recordingUid = null;
      }
    }
    // Konec vždycky teď (dřív jen u živého řádku - starý konec pak Cloudflare oživil
    // dobíhající záznam jako "nové vysílání") a značka, že skončilo tlačítkem v appce:
    // tentýž záznam se už sám nevrátí (lib/liveSignal.ts, decideLive).
    await write({ ...stopPatch, ended_at: nowIso, app_stopped_at: nowIso, stopped_video_uid: recordingUid });
    if (row.is_live) await addLiveSeconds(row, nowIso);
    // Záznam rovnou na Kine, když si to tvůrce zapnul (studio / appka).
    const published = row.is_live ? await autoPublishAfterStream(ownerId) : null;
    return { confirmed: false, migrated, viewers: null, recording: published?.ok ? { videoId: published.videoId, status: published.status } : null, recordingUid };
  }

  const wasLive = row.is_live;
  // Ukončený přenos (appkou nebo pro dlouhé nepotvrzení) oživí "začal jsem"; samotné "pořád
  // vysílám" jen s důkazem od Cloudflare, že vstup opravdu vysílá (lib/liveSignal.ts - pingRevives).
  // Dřív přenos, který Cloudflare minuty "nepotvrdil" (i když vysílal), zmizel natrvalo.
  let revive = action === 'started' || wasLive || !!row.app_ping_at;
  let seenVideo: { uid: string; created: string | null } | null = null;
  if (!revive && action === 'ping' && row.cf_input_id) {
    const [life, video] = await Promise.all([inputSeen(row.cf_input_id), liveVideoOfInput(row.cf_input_id)]);
    const hls = !video && life.live !== true ? await inputHlsLive(row.cf_input_id) : null;
    const videoUid = life.videoUid ?? video?.uid ?? null;
    rememberEvidence(row.cf_input_id, { lifecycle: life.live, listed: !!video, hls, videoUid });
    if (pingRevives(row, { listed: !!video, connected: life.live, hls, videoUid, videoCreatedAt: video?.created ?? null })) {
      revive = true;
      seenVideo = video ?? null;
      logLiveEvent(ownerId, 'revive', 'zase živě - appka vysílá a Cloudflare vstup vidí', {
        'lifecycle (přijímá vysílání)': life.live ?? 'nejde zjistit',
        'běžící záznam vstupu': video?.uid ?? 'ne',
        'HLS vstupu': hls ?? 'neptáno',
        'konec minulého (s)': secondsSince(row.ended_at),
      });
    }
  }
  if (action === 'started') {
    logLiveEvent(ownerId, 'start', wasLive ? 'appka začala vysílat (přenos už byl živě)' : 'appka začala vysílat', {
      'konec minulého (s)': secondsSince(row.ended_at),
      'databáze má sloupec app_ping_at': migrated,
    });
  }
  if (revive) {
    await write({
      app_ping_at: nowIso,
      is_live: true,
      ended_at: null,
      // Nepotvrzený přenos z poslední čtvrthodiny si nechá původní začátek (lib/liveSignal.ts);
      // přenos vrácený podle Cloudflare začal, když Cloudflare založil jeho záznam.
      started_at: wasLive && row.started_at ? row.started_at : seenVideo?.created ?? revivedStartedAt(row),
      ...(wasLive ? {} : { current_video_uid: null }),
      // Nové vysílání z appky: minulé Ukončit už neplatí.
      ...(row.app_stopped_at || row.stopped_video_uid ? { app_stopped_at: null, stopped_video_uid: null } : {}),
      updated_at: nowIso,
    });
  }

  // Srovnat s Cloudflare (nejvýš jednou za pár vteřin) a říct appce, jestli proud vidí. Začátek
  // vysílání a přenos vrácený podle Cloudflare hned (ať se potvrdí, ne až za 12 s).
  await syncLiveStreams(action === 'started' || (revive && !wasLive) ? { force: true } : {});
  const { data: afterData } = await supabaseServer.from('live_streams').select('*').eq('owner_id', ownerId).maybeSingle();
  const after = afterData as LiveStreamRow | null;
  const confirmed = !!after?.is_live && !!after?.current_video_uid;
  const evidence = () => {
    const e = after?.cf_input_id ? lastEvidence.get(after.cf_input_id) : row.cf_input_id ? lastEvidence.get(row.cf_input_id) : undefined;
    return e && Date.now() - e.at < 2 * 60 * 1000 ? { lifecycle: e.lifecycle, listed: e.listed, hls: e.hls } : null;
  };

  if (migrated && after?.is_live && !confirmed && !appSignalTrusted(after)) {
    // Než se přenos stáhne: vidí ho Cloudflare (běžící záznam vstupu, živý HLS)? Pak zůstává -
    // potvrdí ho další srovnání (stahoval se i přenos, který Cloudflare vysílal).
    const [video, life] = await Promise.all([liveVideoOfInput(after.cf_input_id), inputSeen(after.cf_input_id)]);
    const hls = !video && life.live !== true ? await inputHlsLive(after.cf_input_id) : null;
    rememberEvidence(after.cf_input_id, { lifecycle: life.live, listed: !!video, hls, videoUid: life.videoUid ?? video?.uid ?? null });
    if (!video && life.live !== true && hls !== true) {
      // Cloudflare přenos dlouho nevidí (špatný klíč, nic se neposílá...) - z "Živě" pryč.
      logLiveEvent(ownerId, 'unconfirmed', 'ukončeno - appka hlásí vysílání, ale Cloudflare ho minuty nevidí (špatný klíč? nic nejde ven?)', {
        'začátek (s)': secondsSince(after.started_at),
        'Cloudflare naposledy potvrdil (s)': secondsSince(lastConfirmedIso(after)),
        'vstup Cloudflare': after.cf_input_id,
        'lifecycle (přijímá vysílání)': life.live ?? 'nejde zjistit',
        'HLS vstupu': hls ?? 'nejde zjistit',
      });
      await write({ ...stopPatch, ended_at: nowIso });
      return { confirmed: false, migrated, viewers: null, live: false, cloudflare: evidence() };
    }
  }

  const viewers = confirmed && after ? await liveViewerCount(after.cf_input_id) : null;
  // Záznam běžícího vysílání (appka ho zná hned - Zahodit po konci pak míří přesně na něj).
  const recordingUid = confirmed && after ? after.current_video_uid ?? null : null;
  return {
    confirmed,
    migrated,
    viewers,
    recordingUid,
    hidden: !!after?.is_live && liveHiddenNow(after as any),
    live: !!after?.is_live,
    cloudflare: evidence(),
  };
}

/**
 * Odběratelé (se zapnutým zvonečkem) dostanou "X je živě". Jednou za přenos
 * a nejvýš jednou za půl hodiny - o to se postará podmíněný zápis: kdo ho
 * udělá první, ten oznámení pošle, souběžný dotaz už ne.
 */
async function notifyGoingLive(row: LiveStreamRow, videoUid: string): Promise<void> {
  if (row.notified_video_uid === videoUid) return;
  if (row.notified_at && Date.now() - new Date(row.notified_at).getTime() < RENOTIFY_AFTER_MS) {
    await supabaseServer.from('live_streams').update({ notified_video_uid: videoUid }).eq('owner_id', row.owner_id);
    return;
  }
  const claim = await supabaseServer
    .from('live_streams')
    .update({ notified_video_uid: videoUid, notified_at: new Date().toISOString() })
    .eq('owner_id', row.owner_id)
    .or(`notified_video_uid.is.null,notified_video_uid.neq.${videoUid}`)
    .select('owner_id');
  if (claim.error || !claim.data || claim.data.length === 0) return;

  const [{ data: subs }, { data: profile }, reminded] = await Promise.all([
    supabaseServer.from('subscriptions').select('subscriber_id').eq('channel_id', row.owner_id).eq('notify_new_videos', true),
    supabaseServer.from('profiles').select('username, display_name, is_banned, is_shadow_banned').eq('id', row.owner_id).maybeSingle(),
    // Kdo si u plánovaného vysílání dal „Připomenout“ (lib/liveScheduleServer.ts) - připomenutí se tím spotřebují.
    takeReminders(row.owner_id).catch(() => [] as string[]),
  ]);
  // Zablokovaný nebo shadow-banovaný kanál odběratelům nic nehlásí (klíč pro OBS mu dál funguje).
  if (profile?.is_banned || profile?.is_shadow_banned) return;
  const recipients = new Set<string>([...(subs ?? []).map((s: any) => String(s.subscriber_id)), ...reminded]);
  recipients.delete(row.owner_id);
  if (recipients.size === 0) return;
  const name = profile?.display_name || profile?.username || 'Kanál';
  const title = row.title?.trim();
  const { data: inserted } = await supabaseServer
    .from('notifications')
    .insert(
      [...recipients].map((userId) => ({
        user_id: userId,
        type: 'live',
        message: title ? `🔴 ${name} je živě: ${title}` : `🔴 ${name} je živě`,
        link: `/live/${row.owner_id}`,
      }))
    )
    .select('id');
  // I na telefon / počítač (push) - kdo si oznámení zapnul (lib/pushSend.ts).
  runInBackground(pushNotificationsByIds(insertedIds(inserted)), 'push - je živě');
}

/** Veřejné údaje o přenosu pro stránky (bez klíče). */
export type PublicLive = {
  ownerId: string;
  live: boolean;
  title: string;
  description: string;
  category: string | null;
  startedAt: string | null;
  endedAt: string | null;
  inputId: string;
  videoUid: string | null;
  /** Přehrávač Cloudflare; null = zatím nejde (Cloudflare přenos ještě nepotvrdil a kód zákazníka není znám). */
  playerUrl: string | null;
  /** HLS vstupu (appka si podle něj ověřuje, že diváci obraz vidí); null = kód zákazníka není znám. */
  hlsUrl: string | null;
  /** Od kdy ukazovat chat - každé vysílání má svůj (lib/liveChat.ts). */
  chatSince: string | null;
  /** Vlastní náhled přenosu; null = snímek z vysílání od Cloudflare. */
  thumbnailUrl: string | null;
  /** Hra (lib/games.ts - slug): nastavená ve studiu, z appky podle názvu; null = žádná. */
  game: string | null;
};

export async function publicLive(row: LiveStreamRow): Promise<PublicLive> {
  const code = await streamCustomerCode();
  return {
    chatSince: chatSessionSince({ live: row.is_live, startedAt: row.started_at, endedAt: row.ended_at }),
    thumbnailUrl: typeof row.thumbnail_url === 'string' && /^https:\/\//.test(row.thumbnail_url) ? row.thumbnail_url : null,
    game: liveGameSlug(row),
    ownerId: row.owner_id,
    live: row.is_live,
    title: row.title,
    description: row.description,
    category: row.category,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    inputId: row.cf_input_id,
    videoUid: row.current_video_uid,
    playerUrl: livePlayerUrl(row.cf_input_id, row.current_video_uid, code),
    hlsUrl: liveHlsUrl(row.cf_input_id, code),
  };
}
