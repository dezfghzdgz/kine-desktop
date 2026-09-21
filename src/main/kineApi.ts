/**
 * Volání na Kine (stejné cesty, jaké používá webová appka při nahrávání).
 *
 *  POST /api/videos/create-upload-url  { fileSize, preferResumable }
 *       -> { mode: 'tus' | 'basic', uploadURL, videoId }
 *  POST /api/videos/confirm            { title, cloudflareVideoId, ... }
 *       -> { video: { id } }
 *
 * Token je přístupový token Supabase (Bearer); dodává ho auth.ts.
 */

export class KineApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'KineApiError';
  }
}

export type UploadTarget = { mode: 'tus' | 'basic'; uploadURL: string; videoId: string };

export type ConfirmInput = {
  title: string;
  description: string;
  cloudflareVideoId: string;
  language: string;
  visibility: 'public' | 'private';
  width: number | null;
  height: number | null;
  hashtags: string[];
};

export type KineApi = {
  siteUrl(): string;
  createUploadUrl(fileSize: number): Promise<UploadTarget>;
  confirm(input: ConfirmInput): Promise<{ id: string }>;
};

export function createKineApi(deps: {
  siteUrl: () => string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): KineApi {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function post(path: string, body: unknown): Promise<any> {
    const token = await deps.getToken();
    if (!token) throw new KineApiError('Nejsi přihlášený.', 401);
    const res = await fetchImpl(`${deps.siteUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new KineApiError(typeof data?.error === 'string' ? data.error : `Kine odpověděla ${res.status}.`, res.status);
    return data;
  }

  return {
    siteUrl: deps.siteUrl,
    async createUploadUrl(fileSize) {
      const data = await post('/api/videos/create-upload-url', { fileSize, preferResumable: true });
      if (!data?.uploadURL || !data?.videoId) throw new KineApiError('Kine nevrátila adresu pro nahrání.', 500);
      return { mode: data.mode === 'tus' ? 'tus' : 'basic', uploadURL: data.uploadURL, videoId: data.videoId };
    },
    async confirm(input) {
      const data = await post('/api/videos/confirm', {
        title: input.title,
        description: input.description,
        cloudflareVideoId: input.cloudflareVideoId,
        madeForKids: false,
        hasPaidPromotion: false,
        isAiGenerated: false,
        language: input.language,
        category: 'catGaming',
        visibility: input.visibility,
        isPremiere: false,
        scheduledAt: null,
        width: input.width,
        height: input.height,
        chapters: [],
        captions: [],
        hashtags: input.hashtags,
      });
      if (!data?.video?.id) throw new KineApiError('Kine video neuložila.', 500);
      return { id: data.video.id as string };
    },
  };
}
