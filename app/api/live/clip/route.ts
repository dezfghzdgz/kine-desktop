import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { isMissingTable, userFromRequest } from '@/lib/apiUser';
import { CLIPS_PER_DAY, clipTitle } from '@/lib/clips';
import { cloudflareStorageFull, cloudflareStreamCreds, deleteStreamVideo, isCloudflareUid, streamApiUrl } from '@/lib/cloudflareVideos';
import { lockKey, withUserLock } from '@/lib/userLock';
import { channelRoom } from '@/lib/liveChat';
import { activeBan } from '@/lib/liveChatModeration';
import { cloudflareVideo, streamCustomerCode, type LiveStreamRow } from '@/lib/liveStream';
import { liveHiddenNow } from '@/lib/nudityRules';
import { liveGameSlug, withGameTag } from '@/lib/games';
import { LIVE_CLIP_SECONDS, liveClipMp4Url, liveClipWindow, livePreviewManifestUrl, readPreviewStart } from '@/lib/liveClip';
import { allowRequest, tooManyRequests } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
// Zámek, náhled, dotaz na Cloudflare a kopie můžou dohromady trvat přes půl minuty.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGS = ['cs', 'sk', 'en', 'de', 'es', 'fr', 'pl', 'uk'];
/** Stejný divák: další klip nejdřív za tolik (dvojklik nevyrobí dva stejné). */
const SAME_STREAM_GAP_MS = 15 * 1000;

const noStore = { 'Cache-Control': 'no-store' };
const fail = (status: number, error: string, code?: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...(code ? { code } : {}), ...extra }, { status, headers: noStore });

/**
 * Klip z živého vysílání: POST { channel, lang? } -> { clipId, title }
 *
 * Uloží posledních ~30 s přenosu jako nové video (lib/liveClip.ts):
 * Cloudflare vyrobí MP4 ze záznamu vysílání a Kine ho hned zkopíruje
 * (API "copy") - klip ze záznamu by jinak zmizel spolu se záznamem.
 * Klip vlastní streamer, u klipu je uvedený divák, který ho udělal
 * (clipped_by) - stejně jako klipy z videí (app/api/videos/clip).
 * Denní strop klipů je společný (lib/clips.ts - CLIPS_PER_DAY).
 */
export async function POST(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return fail(401, 'Musíš být přihlášený.', 'auth');
  if (!allowRequest(`live-clip:${user.id}`, 4, 60 * 1000)) return tooManyRequests(20);

  const body = await req.json().catch(() => ({}));
  const channel = typeof body?.channel === 'string' && UUID.test(body.channel) ? body.channel.toLowerCase() : null;
  if (!channel) return fail(400, 'Neplatný kanál.');
  const lang = LANGS.includes(body?.lang) ? (body.lang as string) : 'cs';

  const [meRes, rowRes, ownerRes, chatBan] = await Promise.all([
    supabaseServer.from('profiles').select('is_banned').eq('id', user.id).maybeSingle(),
    supabaseServer.from('live_streams').select('*').eq('owner_id', channel).maybeSingle(),
    supabaseServer.from('profiles').select('username, display_name, is_banned, is_shadow_banned').eq('id', channel).maybeSingle(),
    activeBan(channelRoom(channel), user.id),
  ]);
  if ((meRes.data as { is_banned?: boolean } | null)?.is_banned) return fail(403, 'Účet je zablokovaný.', 'banned');
  // Kdo má v chatu kanálu zákaz, ten mu ani neklipuje (klipy jsou na jeho kanálu vidět).
  if (chatBan) return fail(403, 'Na tomhle kanálu teď klipy dělat nemůžeš.', 'blocked');
  if (isMissingTable(rowRes.error) || !rowRes.data || !ownerRes.data) return fail(404, 'Přenos nenalezen.', 'not-found');
  const stream = rowRes.data as LiveStreamRow;
  const owner = ownerRes.data as { username: string | null; display_name: string | null; is_banned?: boolean; is_shadow_banned?: boolean };
  const uid = stream.current_video_uid;
  if (!stream.is_live || !isCloudflareUid(uid)) return fail(409, 'Kanál teď nevysílá.', 'not-live');
  // Přenos, který ostatní nevidí (zablokovaný, shadow-ban, skrytý kontrolou obsahu), se neklipuje.
  if (owner.is_banned || owner.is_shadow_banned || liveHiddenNow(stream as any)) return fail(403, 'Z tohohle přenosu teď klip udělat nejde.', 'unavailable');

  const cf = cloudflareStreamCreds();
  const code = await streamCustomerCode();
  if (!cf || !code) return fail(503, 'Klipy z vysílání teď nejdou (Cloudflare není nastavený).', 'not-configured');

  // Pod zámkem (lib/userLock.ts): souběžné kliknutí by jinak prošlo stropem dvakrát.
  const locked = await withUserLock(
    lockKey('clip', user.id),
    async () => {
      const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const recent = await supabaseServer
        .from('videos')
        .select('created_at', { count: 'exact' })
        .eq('clipped_by', user.id)
        .gte('created_at', since24h)
        .order('created_at', { ascending: false })
        .limit(1);
      if (recent.error) return fail(503, 'Klipy zatím nejsou zapnuté (chybí migrace supabase-migration-klipy.sql).', 'not-configured');
      if ((recent.count ?? 0) >= CLIPS_PER_DAY) return fail(429, `Dnes už máš ${CLIPS_PER_DAY} klipů. Zkus to zítra.`, 'limit');
      const lastAt = recent.data?.[0]?.created_at ? Date.parse(recent.data[0].created_at) : 0;
      if (Date.now() - lastAt < SAME_STREAM_GAP_MS) return fail(429, 'Klip se právě ukládá - další jde za chvilku.', 'busy', { retryS: 15 });

      // Kde začíná posledních 30 s (hlavička náhledového manifestu), jinak z délky vysílání.
      let previewStart: number | null = null;
      const manifest = livePreviewManifestUrl(code, uid);
      if (manifest) {
        try {
          const res = await fetch(manifest, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
          previewStart = res.ok ? readPreviewStart(res.headers.get('preview-start-seconds')) : null;
        } catch {
          previewStart = null;
        }
      }
      const startedMs = Date.parse(stream.started_at ?? '');
      let elapsed: number | null = Number.isFinite(startedMs) ? (Date.now() - startedMs) / 1000 : null;
      if (previewStart === null) {
        // Cloudflare ví přesně, kdy záznam začal (náš čas začátku může být o pár vteřin pozadu).
        const video = await cloudflareVideo(uid);
        const created = Date.parse(video?.created ?? '');
        if (Number.isFinite(created)) elapsed = (Date.now() - created) / 1000;
      } else if (elapsed !== null && elapsed > 2 * LIVE_CLIP_SECONDS) {
        // Dlouhé vysílání: strop podle našeho času začátku není potřeba (a mohl by klip zbytečně zkrátit).
        elapsed = null;
      }
      const window = liveClipWindow({ previewStart, elapsed });
      if (!window.ok) {
        return window.reason === 'too-early'
          ? fail(409, 'Vysílání teprve začalo - klip půjde za pár vteřin.', 'too-early')
          : fail(503, 'Klip teď nejde udělat - zkus to za chvíli.', 'unavailable');
      }
      const url = liveClipMp4Url(code, uid, window);
      if (!url) return fail(503, 'Klip teď nejde udělat - zkus to za chvíli.', 'unavailable');
      const name = owner.display_name || owner.username || 'Kine';
      const title = clipTitle(stream.title?.trim() || `${name} – živě`, window.time, window.time + window.duration);

      // Kopie klipu jako nové video u Cloudflare (stáhne si ho samo z adresy klipu).
      let clipUid: string | null = null;
      try {
        const res = await fetch(streamApiUrl(cf.accountId, '/copy'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, meta: { name: title }, thumbnailTimestampPct: 0.5 }),
          signal: AbortSignal.timeout(15 * 1000),
        });
        const data = await res.json().catch(() => null);
        if (!data?.success || !isCloudflareUid(data?.result?.uid)) {
          if (cloudflareStorageFull(data?.errors)) return fail(507, 'Úložiště videí je plné - klip teď uložit nejde.', 'storage-full');
          console.error('Kine: klip z vysílání - Cloudflare odmítl kopii', res.status, JSON.stringify(data?.errors ?? null));
          return fail(502, 'Cloudflare klip neuložil - zkus to za chvíli.', 'cloudflare');
        }
        clipUid = data.result.uid as string;
      } catch (e) {
        console.error('Kine: klip z vysílání - Cloudflare neodpověděl', e instanceof Error ? e.message : e);
        return fail(502, 'Cloudflare se nepodařilo zavolat - zkus to za chvíli.', 'cloudflare');
      }

      const game = liveGameSlug(stream);
      const { data: clip, error: insertError } = await supabaseServer
        .from('videos')
        .insert({
          owner_id: channel,
          title,
          description: null,
          cloudflare_video_id: clipUid,
          status: 'processing',
          visibility: 'public',
          category: stream.category ?? null,
          language: lang,
          made_for_kids: false,
          hashtags: withGameTag([], game),
          duration_seconds: window.duration,
          chapters: [],
          captions: [],
          clipped_by: user.id,
        })
        .select('id')
        .single();
      if (insertError || !clip) {
        // Video u Cloudflare by jinak viselo bez řádku (a platilo by se za ně).
        console.error('Kine: klip z vysílání se neuložil -', insertError?.message);
        await deleteStreamVideo(clipUid);
        return fail(500, 'Klip se nepodařilo uložit.', 'db');
      }
      return NextResponse.json({ clipId: clip.id, title, seconds: window.duration }, { headers: noStore });
    },
    { waitMs: 6000 }
  );
  if (!locked.ok) return fail(429, 'Jiný klip se právě ukládá - zkus to za pár sekund znovu.', 'busy', { retryS: 3 });
  return locked.value;
}
