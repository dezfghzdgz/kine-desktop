import type { LiveCloudflareSeen, Visibility } from '../shared/types';

/**
 * Volání na Kine (stejné cesty, jaké používá webová appka při nahrávání).
 *
 *  POST /api/videos/create-upload-url  { fileSize, preferResumable }
 *       -> { mode: 'tus' | 'basic', uploadURL, videoId }
 *  POST /api/videos/confirm            { title, cloudflareVideoId, ... }
 *       -> { video: { id } }
 *  POST /api/videos/status             { videoId }
 *       -> { status: 'ready' | 'processing' }   (Kine se zeptá Cloudflare)
 *
 * Token je přístupový token Supabase (Bearer); dodává ho auth.ts.
 */

export class KineApiError extends Error {
  /** Kine říká "zkus to znovu za chvíli" (záznam vysílání ještě není / se uzavírá). */
  readonly retry: boolean;
  constructor(message: string, readonly status: number, retry = false) {
    super(message);
    this.name = 'KineApiError';
    this.retry = retry;
  }
}

export type UploadTarget = { mode: 'tus' | 'basic'; uploadURL: string; videoId: string };

export type ConfirmInput = {
  title: string;
  description: string;
  cloudflareVideoId: string;
  language: string;
  visibility: 'public' | 'subscribers' | 'private';
  width: number | null;
  height: number | null;
  hashtags: string[];
  /** Kapitoly (s od začátku) - Kine je ukáže na časové ose videa. */
  chapters?: { time: number; title: string }[];
  category: string;
  madeForKids: boolean;
  hasPaidPromotion: boolean;
  isAiGenerated: boolean;
};

export type VideoStatus = 'ready' | 'processing' | 'not-found';

/** Živé vysílání na Kine (/api/live/me): klíč pro vysílání a stav přenosu. */
export type LiveSetup = {
  /** Má server Cloudflare Stream? */
  configured: boolean;
  /** Proběhla na Kine migrace živého vysílání? */
  migrated: boolean;
  input: { rtmpsUrl: string; streamKey: string } | null;
  stream: {
    ownerId: string;
    title: string;
    description: string;
    category: string | null;
    /** Vlastní náhled přenosu (null = snímek z vysílání; undefined = starší Kine to neumí). */
    thumbnailUrl?: string | null;
    /** HLS vysílání u Cloudflare - appka podle něj hlídá, že diváci obraz vidí (null = starší Kine / neznámý kód). */
    hlsUrl?: string | null;
  } | null;
  /** Co se záznamem po skončení (null = nechat ve studiu). */
  recordingVisibility: Visibility | null;
  /** Umí Kine záznam zveřejnit sama (migrace supabase-migration-zive-2.sql)? */
  recordingAutoSupported: boolean;
};

/** Záznam vysílání zveřejněný jako video na Kine. */
export type PublishedRecording = { videoId: string; status: 'ready' | 'processing'; alreadyPublished: boolean };

export type KineApi = {
  siteUrl(): string;
  /** `durationSeconds`: délka klipu (Kine podle ní hlídá limity a rezervuje místo); null = neznámá. */
  createUploadUrl(fileSize: number, durationSeconds?: number | null): Promise<UploadTarget>;
  confirm(input: ConfirmInput): Promise<{ id: string }>;
  /**
   * Je video na Kine už zpracované? Kine se zeptá Cloudflare a když je
   * hotovo, přepne ho na "ready" - do té doby není v žádném seznamu na
   * Kine vidět. Volá se po nahrání dokola, dokud není hotovo.
   */
  status(videoId: string, onPercent?: (percent: number) => void): Promise<VideoStatus>;
  /** Klíč a stav živého vysílání přihlášeného hráče. */
  liveSetup(): Promise<LiveSetup>;
  /** Založí klíč pro vysílání (když ještě není) a vrátí ho. */
  liveCreate(): Promise<LiveSetup>;
  /** Název, popis a kategorie přenosu (vidí je diváci na Kine). */
  liveDetails(details: { title: string; description: string; category: string | null }): Promise<void>;
  /** Co se záznamem po skončení vysílání (null = nechat ve studiu, jinak zveřejnit s touhle viditelností). */
  liveSetRecordingVisibility(visibility: Visibility | null): Promise<{ value: Visibility | null; supported: boolean }>;
  /** Záznam posledního vysílání -> video na Kine (Cloudflare ho nahrálo samo). */
  livePublishRecording(options: { title: string; visibility: Visibility; language?: string }): Promise<PublishedRecording>;
  /**
   * Appka řekne Kine, že vysílá (started / ping po ~15 s / stopped). Kine podle
   * toho ukáže vysílání jako živé hned, ne až když ho najde u Cloudflare.
   * `confirmed`: Cloudflare proud opravdu přijímá.
   */
  liveSignal(action: 'started' | 'ping' | 'stopped'): Promise<{
    confirmed: boolean;
    viewers: number | null;
    recording: { videoId: string; status: 'ready' | 'processing' } | null;
    recordingUid?: string | null;
    /** Je přenos na Kine živě (novější Kine; starší null). */
    live?: boolean | null;
    /** Co o vstupu řekl Cloudflare (novější Kine) - do deníku. */
    cloudflare?: LiveCloudflareSeen | null;
    /** Kontrola obsahu přenos skryla z Živě (čeká na moderátora) - jen majitel ho tam vidí. */
    hidden?: boolean;
  }>;
  /**
   * Záznam vysílání ke stažení do PC: Kine ho nechá u Cloudflare vyrobit jako
   * MP4 - "inprogress" = zeptat se znovu za chvíli. videoUid "latest" = poslední.
   */
  liveRecordingDownload(videoUid: string): Promise<{ uid: string; status: 'ready' | 'inprogress'; url: string | null; percent: number | null }>;
  /** Zahodit záznam vysílání (smaže se u Cloudflare, nikde se neuloží) - vždy konkrétní id, ne "latest". */
  /**
   * Zahodit záznam: podle id, nebo (appka id nezná) všechny záznamy z okna vysílání
   * `since`-`until` (ms). Chyba se `retry` = záznam ještě není / vysílání se ještě uzavírá.
   */
  liveRecordingDiscard(target: string | { since: number; until: number }): Promise<{ uid: string; uids: string[] }>;
  /** Vlastní náhled přenosu (JPEG 1280×720) -> Kine; vrací jeho adresu. */
  liveSetThumbnail(jpeg: Uint8Array): Promise<{ thumbnailUrl: string | null }>;
  /** Náhled přenosu zase jako snímek z vysílání. */
  liveRemoveThumbnail(): Promise<void>;
};

const VISIBILITY_VALUES: readonly Visibility[] = ['public', 'subscribers', 'private'];
function visibilityFrom(value: unknown): Visibility | null {
  return VISIBILITY_VALUES.includes(value as Visibility) ? (value as Visibility) : null;
}

function liveSetupFrom(data: any): LiveSetup {
  const input = data?.input && typeof data.input.rtmpsUrl === 'string' && typeof data.input.streamKey === 'string' ? { rtmpsUrl: data.input.rtmpsUrl as string, streamKey: data.input.streamKey as string } : null;
  const s = data?.stream;
  return {
    configured: data?.configured !== false,
    migrated: data?.migrated !== false,
    input,
    stream:
      s && typeof s.ownerId === 'string'
        ? {
            ownerId: s.ownerId,
            title: String(s.title ?? ''),
            description: String(s.description ?? ''),
            category: typeof s.category === 'string' ? s.category : null,
            // Starší Kine pole vůbec nepošle (undefined) - appka pak náhled nenabízí jako uložený.
            ...(s.thumbnailUrl === undefined ? {} : { thumbnailUrl: typeof s.thumbnailUrl === 'string' && /^https:\/\//.test(s.thumbnailUrl) ? s.thumbnailUrl : null }),
            // Jen HLS od Cloudflare (appka ho čte jako divák - nic jiného tudy nepouští).
            hlsUrl: typeof s.hlsUrl === 'string' && /^https:\/\/customer-[a-z0-9]+\.cloudflarestream\.com\//i.test(s.hlsUrl) ? s.hlsUrl : null,
          }
        : null,
    recordingVisibility: visibilityFrom(data?.recordingVisibility),
    recordingAutoSupported: data?.recordingAutoSupported === true,
  };
}

export function createKineApi(deps: {
  siteUrl: () => string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Kine odpověděla 426: appka je moc stará (nahrávat a vysílat nepůjde, dokud se neaktualizuje). */
  onUpdateRequired?: () => void;
}): KineApi {
  const rawFetch = deps.fetchImpl ?? fetch;
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const res = await rawFetch(input, init);
    if (res.status === 426) {
      try {
        deps.onUpdateRequired?.();
      } catch {
        // Hlášení "aktualizuj" nesmí shodit volání.
      }
    }
    return res;
  }) as typeof fetch;

  async function post(path: string, body: unknown, timeoutMs?: number): Promise<any> {
    const token = await deps.getToken();
    if (!token) throw new KineApiError('Nejsi přihlášený.', 401);
    const res = await fetchImpl(`${deps.siteUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new KineApiError(typeof data?.error === 'string' ? data.error : `Kine odpověděla ${res.status}.`, res.status, data?.retry === true);
    return data;
  }

  async function get(path: string): Promise<any> {
    const token = await deps.getToken();
    if (!token) throw new KineApiError('Nejsi přihlášený.', 401);
    const res = await fetchImpl(`${deps.siteUrl()}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new KineApiError(typeof data?.error === 'string' ? data.error : `Kine odpověděla ${res.status}.`, res.status);
    return data;
  }

  return {
    siteUrl: deps.siteUrl,
    async createUploadUrl(fileSize, durationSeconds) {
      const data = await post('/api/videos/create-upload-url', {
        fileSize,
        preferResumable: true,
        ...(typeof durationSeconds === 'number' && durationSeconds > 0 ? { durationSeconds } : {}),
      });
      if (!data?.uploadURL || !data?.videoId) throw new KineApiError('Kine nevrátila adresu pro nahrání.', 500);
      return { mode: data.mode === 'tus' ? 'tus' : 'basic', uploadURL: data.uploadURL, videoId: data.videoId };
    },
    async confirm(input) {
      const data = await post('/api/videos/confirm', {
        title: input.title,
        description: input.description,
        cloudflareVideoId: input.cloudflareVideoId,
        madeForKids: input.madeForKids,
        hasPaidPromotion: input.hasPaidPromotion,
        isAiGenerated: input.isAiGenerated,
        language: input.language,
        category: input.category,
        visibility: input.visibility,
        isPremiere: false,
        scheduledAt: null,
        width: input.width,
        height: input.height,
        chapters: input.chapters ?? [],
        captions: [],
        hashtags: input.hashtags,
      });
      if (!data?.video?.id) throw new KineApiError('Kine video neuložila.', 500);
      return { id: data.video.id as string };
    },
    async status(videoId, onPercent) {
      // Bez přihlášení to jde taky (stav videa není tajný), token se ale pošle, když je.
      const token = await deps.getToken();
      const res = await fetchImpl(`${deps.siteUrl()}/api/videos/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ videoId }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404) return 'not-found';
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new KineApiError(typeof data?.error === 'string' ? data.error : `Kine odpověděla ${res.status}.`, res.status);
      if (data?.status === 'ready') return 'ready';
      // Novější Kine řekne, kolik má Cloudflare zpracováno (dlouhá videa trvají minuty).
      if (Number.isFinite(data?.percent) && data.percent >= 0 && data.percent <= 100) onPercent?.(Math.floor(data.percent));
      return 'processing';
    },
    async liveSetup() {
      return liveSetupFrom(await get('/api/live/me'));
    },
    async liveCreate() {
      return liveSetupFrom({ configured: true, migrated: true, ...(await post('/api/live/me', { action: 'create' })) });
    },
    async liveSignal(action) {
      const data: any = await post('/api/live/me', { action });
      // Počet diváků posílá novější Kine (Cloudflare); starší nic - pak null.
      const viewers = Number.isInteger(data?.viewers) && data.viewers >= 0 ? Number(data.viewers) : null;
      // Po "stopped": záznam, který Kine zveřejnila sama (nastavení "Po skončení vysílání").
      const r = data?.recording;
      const recording = r && typeof r.videoId === 'string' ? { videoId: r.videoId as string, status: r.status === 'ready' ? ('ready' as const) : ('processing' as const) } : null;
      // Po "stopped": id záznamu právě skončeného vysílání (novější Kine) - Stáhnout / Zahodit míří na něj.
      const recordingUid = typeof data?.recordingUid === 'string' && /^[a-z0-9]{6,64}$/i.test(data.recordingUid) ? (data.recordingUid as string) : null;
      // Novější Kine: je přenos na Kine živě a co o vstupu říká Cloudflare (starší nic - null).
      const live = typeof data?.live === 'boolean' ? (data.live as boolean) : null;
      const c = data?.cloudflare;
      const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
      const cloudflare: LiveCloudflareSeen | null = c && typeof c === 'object' ? { lifecycle: tri(c.lifecycle), listed: c.listed === true, hls: tri(c.hls) } : null;
      return { confirmed: data?.confirmed === true, viewers, recording, recordingUid, live, cloudflare, hidden: data?.hidden === 'moderation' };
    },
    async liveDetails(details) {
      await post('/api/live/me', { action: 'details', title: details.title.slice(0, 100), description: details.description.slice(0, 2000), category: details.category });
    },
    async liveSetRecordingVisibility(visibility) {
      const data: any = await post('/api/live/me', { action: 'details', recordingVisibility: visibility }, 20000);
      // Starší Kine (bez migrace) hodnotu neuloží a pošle recordingAutoSupported: false.
      return { value: visibilityFrom(data?.recordingVisibility), supported: data?.recordingAutoSupported !== false };
    },
    async liveSetThumbnail(jpeg) {
      const token = await deps.getToken();
      if (!token) throw new KineApiError('Nejsi přihlášený.', 401);
      const res = await fetchImpl(`${deps.siteUrl()}/api/live/thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` },
        body: jpeg as unknown as BodyInit,
        signal: AbortSignal.timeout(45000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new KineApiError(typeof data?.error === 'string' ? data.error : `Kine odpověděla ${res.status}.`, res.status);
      // Jen https (jako u liveSetupFrom) - adresa jde do <img> v okně appky.
      return { thumbnailUrl: typeof data?.thumbnailUrl === 'string' && /^https:\/\//.test(data.thumbnailUrl) ? data.thumbnailUrl : null };
    },
    async liveRemoveThumbnail() {
      const token = await deps.getToken();
      if (!token) throw new KineApiError('Nejsi přihlášený.', 401);
      const res = await fetchImpl(`${deps.siteUrl()}/api/live/thumbnail`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new KineApiError(typeof data?.error === 'string' ? data.error : `Kine odpověděla ${res.status}.`, res.status);
    },
    async liveRecordingDownload(videoUid) {
      // Vlastní cesta: starší Kine na ni odpoví 404 (na /api/live/recordings by záznam zveřejnila).
      const data: any = await post('/api/live/recordings/download', { videoUid: videoUid || 'latest' }, 30000);
      if (typeof data?.uid !== 'string') throw new KineApiError('Kine záznam nenašla.', 404);
      const url = typeof data.url === 'string' && /^https:\/\//.test(data.url) ? data.url : null;
      return { uid: data.uid, status: data.status === 'ready' && url ? 'ready' : 'inprogress', url, percent: typeof data.percent === 'number' ? data.percent : null };
    },
    async liveRecordingDiscard(target) {
      // clientNow: hodiny počítače - server si podle nich okno posune na svůj čas (hodiny se můžou lišit).
      const body = typeof target === 'string' ? { videoUid: target } : { since: Math.round(target.since), until: Math.round(target.until), clientNow: Date.now() };
      const data: any = await post('/api/live/recordings/discard', body, 30000);
      if (typeof data?.uid !== 'string') throw new KineApiError('Kine záznam nesmazala.', 500);
      const uids = Array.isArray(data.uids) ? data.uids.filter((u: unknown): u is string => typeof u === 'string') : [data.uid];
      return { uid: data.uid, uids };
    },
    async livePublishRecording(options) {
      const data: any = await post(
        '/api/live/recordings',
        { videoUid: 'latest', title: options.title.slice(0, 150), visibility: options.visibility, language: options.language, rightAfterStream: true },
        45000
      );
      if (typeof data?.videoId !== 'string') throw new KineApiError('Kine záznam nezveřejnila.', 500);
      return { videoId: data.videoId, status: data.status === 'ready' ? 'ready' : 'processing', alreadyPublished: data.alreadyPublished === true };
    },
  };
}
