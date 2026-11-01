import { supabaseServer } from './supabaseServer';
import { shouldBeProtected, syncVideoProtection } from './streamProtection';
import { requestAutoCaptions, sweepCaptions } from './autoCaptions';
import { runInBackground } from './background';
import { insertedIds, pushNotificationsByIds } from './pushSend';
import { isCloudflareUid, processCloudflareCleanup, streamApiUrl, sweepAbandonedUploads } from './cloudflareVideos';
import { expireTickets, markTicketFailed } from './uploadTickets';
import { isKineVideoId } from './videoRef';
import { sweepOrder, uploadNeverFinished } from './videoProcessing';

/**
 * "Video je zpracované" - jedno místo pro obě cesty, kterými se to appka
 * dozví.
 *
 * PROČ TO TU JE
 *
 * Video se do databáze zapíše se stavem "processing" a na "ready" ho
 * přepne teprve někdo, kdo se Cloudflare zeptá. Dokud se to nestane,
 * video nikde není - všechny seznamy berou jen "ready".
 *
 * Ptát se chodil jenom prohlížeč, a to nejvýš dvě minuty po nahrání.
 * Dvanáctiminutové video Cloudflare za dvě minuty nezpracuje, takže
 * dotazování skončilo dřív, video zůstalo navždy ve stavu "processing" a
 * na Kine se neobjevilo - přestože na Cloudflare bylo v pořádku.
 *
 * Odteď vedou k přepnutí dvě cesty:
 *   1. Cloudflare se sám ozve, až je hotovo (webhook). Nezávisí to na
 *      tom, jestli má tvůrce otevřený prohlížeč.
 *   2. Appka se doptá sama, když video někde vypisuje (záloha, kdyby
 *      webhook nebyl nastavený nebo se zpráva ztratila).
 */

export type ReadyResult = 'ready' | 'processing' | 'failed' | 'not-found';

/**
 * Zapíše, že je video hotové, a rozešle oznámení odběratelům.
 *
 * `payload` jsou údaje od Cloudflare (z odpovědi API nebo z webhooku) -
 * obojí má stejná pole.
 */
export async function markVideoReady(
  videoId: string,
  payload: { duration?: number; thumbnail?: string; input?: { width?: number; height?: number } }
): Promise<void> {
  // select('*') schválně: čtou se i sloupce z novějších migrací (klipy),
  // které v databázi ještě být nemusí - výběr podle jména by bez nich spadl.
  const { data: video } = await supabaseServer
    .from('videos')
    .select('*')
    .eq('id', videoId)
    .single();

  if (!video || video.status === 'ready') return;

  const updates: any = {
    status: 'ready',
    duration_seconds: Math.round(payload.duration || 0),
  };
  if (!video.custom_thumbnail && payload.thumbnail) updates.thumbnail_url = payload.thumbnail;
  if (payload.input?.width) updates.width = payload.input.width;
  if (payload.input?.height) updates.height = payload.input.height;

  await supabaseServer.from('videos').update(updates).eq('id', videoId);

  // Neveřejné video: podepsané adresy u Cloudflare a náhled přenesený do
  // úložiště Kine - náhled přímo z Cloudflare by pod ochranou nešel
  // (lib/streamProtection.ts; bez nastaveného klíče nic nedělá).
  if (shouldBeProtected(video.visibility)) {
    await syncVideoProtection(videoId);
  }

  // Automatické titulky (Cloudflare AI) - jen když tvůrce nedal vlastní a jazyk to umí.
  await requestAutoCaptions({ ...video, ...updates });

  // Video se právě stalo "ready" a je veřejné - vhodná chvíle poslat
  // oznámení odběratelům, kteří si to u tohohle kanálu přejí (zvoneček
  // vedle "Odebírat"). Klip není nové video tvůrce (vystřihl ho divák) -
  // odběratelům se nehlásí. Naplánované video a premiéra se hlásí až ve
  // chvíli zveřejnění (sweepScheduled) - dřív to odběratelé dostali hned
  // po nahrání a klikli na video, které ještě nemělo být venku.
  const notify =
    video.visibility === 'public' &&
    !video.clipped_from_video_id &&
    // Klip z živého vysílání (app/api/live/clip) nemá původní video, jen toho, kdo ho udělal.
    !video.clipped_by &&
    !(video.scheduled_at && new Date(video.scheduled_at).getTime() > Date.now());

  // Nejdřív automatická kontrola nahoty a porna (lib/nudityScan.ts) - na
  // pozadí, ať odpověď Cloudflare / prohlížeči nečeká. Skryté video se
  // odběratelům nehlásí (ohlásí se, až ho moderátor pustí).
  runInBackground(checkThenNotify(videoId, notify ? video : null), 'kontrola obsahu videa');
}

async function checkThenNotify(videoId: string, notifyVideo: { id: string; owner_id: string; title: string } | null): Promise<void> {
  let held = false;
  try {
    const { scanVideo } = await import('./nudityScan');
    const result = await scanVideo(videoId);
    held = result.outcome === 'checked' && result.verdict.action === 'hold';
  } catch (err) {
    console.error('Kine: kontrola obsahu videa', err instanceof Error ? err.message : err);
  }
  if (!held && notifyVideo) await notifySubscribers(notifyVideo);
}

/**
 * Oznámení o novém videu odběratelům - právě jednou. Kdo první zapíše
 * subscribers_notified_at (webhook, doptání se, úklid naplánovaných), ten
 * oznámení pošle; ostatní už ne. Bez migrace (sloupec chybí) se pošle
 * bez hlídání, jako dřív.
 */
export async function notifySubscribers(video: { id: string; owner_id: string; title: string }): Promise<void> {
  const claim = await supabaseServer
    .from('videos')
    .update({ subscribers_notified_at: new Date().toISOString() })
    .eq('id', video.id)
    .is('subscribers_notified_at', null)
    .select('id');
  if (claim.error) {
    if (!/subscribers_notified_at/.test(claim.error.message ?? '')) return;
  } else if (!claim.data || claim.data.length === 0) {
    return;
  }

  const { data: subs } = await supabaseServer
    .from('subscriptions')
    .select('subscriber_id')
    .eq('channel_id', video.owner_id)
    .eq('notify_new_videos', true);

  if (!subs || subs.length === 0) return;

  const { data: inserted } = await supabaseServer
    .from('notifications')
    .insert(
      subs.map((s: any) => ({
        user_id: s.subscriber_id,
        type: 'new_video',
        message: `Nové video: "${video.title}"`,
        link: `/watch/${video.id}`,
      }))
    )
    .select('id');
  // I na telefon / počítač (push) - kdo si oznámení zapnul (lib/pushSend.ts).
  runInBackground(pushNotificationsByIds(insertedIds(inserted)), 'push - nové video');
}

/**
 * Naplánovaná videa a premiéry, jejichž čas zveřejnění právě nastal (a
 * videa, která se z neveřejných stala veřejnými): odběratelé dostanou
 * oznámení teď. Jen posledních 7 dní; bez migrace nic nedělá.
 */
export async function sweepScheduled(max = 10): Promise<number> {
  const now = Date.now();
  const { data, error } = await supabaseServer
    .from('videos')
    .select('*')
    .eq('status', 'ready')
    .eq('visibility', 'public')
    .is('subscribers_notified_at', null)
    .gte('created_at', new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString())
    .or(`scheduled_at.is.null,scheduled_at.lte.${new Date(now).toISOString()}`)
    .order('created_at', { ascending: true })
    .limit(max);
  if (error || !data) return 0;
  let sent = 0;
  for (const video of data) {
    if (video.clipped_from_video_id || video.clipped_by) {
      await supabaseServer.from('videos').update({ subscribers_notified_at: new Date().toISOString() }).eq('id', video.id);
      continue;
    }
    try {
      await notifySubscribers(video);
      sent += 1;
    } catch {
      // Jedno video nevyšlo - zkusí se příště.
    }
  }
  return sent;
}

/** Zeptá se Cloudflare na stav videa a případně ho přepne na hotové. */
/** Kolik procent má Cloudflare zpracováno (status.pctComplete, chodí jako text "45.5"); null = neví. */
export function processingPercent(cf: { status?: { pctComplete?: unknown; state?: unknown } } | null | undefined): number | null {
  const raw = cf?.status?.pctComplete;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(99, Math.floor(n)));
}

/**
 * Jedno video se u Cloudflare neptá častěji než jednou za CF_CHECK_EVERY_MS
 * (na instanci). Dotaz na stav jde poslat bez přihlášení - bez tohohle by
 * šlo dokola posílat stav zpracovávaného videa a vyčerpat limit API
 * Cloudflare (1200 dotazů za 5 minut na celý účet), takže by pak nešlo
 * nahrávat ani mazat.
 */
const CF_CHECK_EVERY_MS = 4000;
const lastCfCheck = new Map<string, { at: number; percent: number | null }>();

/**
 * Cloudflare video nezpracoval (delší než ohlášená délka, poškozený soubor)
 * nebo ho u sebe už nemá: video se označí jako nepovedené ('failed') -
 * nikde se neukazuje, tvůrce ho vidí v Moje videa a může ho smazat. Rezerva
 * u Cloudflare se uvolní sama, chybné video se do úložiště nepočítá.
 */
export async function markVideoFailed(videoId: string, cloudflareVideoId: string | null, reason: string | null): Promise<void> {
  await supabaseServer.from('videos').update({ status: 'failed' }).eq('id', videoId).neq('status', 'ready');
  if (cloudflareVideoId) await markTicketFailed(cloudflareVideoId);
  console.warn('Kine: video se u Cloudflare nezpracovalo', videoId, reason ?? '');
}

export async function refreshFromCloudflare(videoId: string, progress?: { percent: number | null }): Promise<ReadyResult> {
  // Jen id videa na Kine (uuid) - cokoli jiného by databáze odmítla chybou (lib/videoRef.ts).
  if (!isKineVideoId(videoId)) return 'not-found';
  const { data: video, error } = await supabaseServer
    .from('videos')
    .select('id, cloudflare_video_id, status, created_at')
    .eq('id', videoId)
    .maybeSingle();

  // Výpadek databáze není "video neexistuje" - appky by si pak klip označily jako smazaný.
  if (error) return 'processing';
  if (!video) return 'not-found';
  if (video.status === 'ready') return 'ready';
  if (video.status === 'failed') return 'failed';

  const last = lastCfCheck.get(videoId);
  if (last && Date.now() - last.at < CF_CHECK_EVERY_MS) {
    if (progress) progress.percent = last.percent;
    return 'processing';
  }
  if (lastCfCheck.size > 2000) lastCfCheck.clear();

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN;
  if (!accountId || !apiToken || !isCloudflareUid(video.cloudflare_video_id)) return 'processing';

  let cfRes: Response;
  try {
    cfRes = await fetch(streamApiUrl(accountId, `/${encodeURIComponent(video.cloudflare_video_id)}`), {
      headers: { Authorization: `Bearer ${apiToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return 'processing';
  }
  const cfData = await cfRes.json().catch(() => ({ success: false }));

  // Cloudflare video nemá (smazané, nedokončené nahrání po vypršení) - na Kine by viselo napořád.
  if (cfRes.status === 404) {
    lastCfCheck.delete(videoId);
    await markVideoFailed(videoId, video.cloudflare_video_id, 'u Cloudflare není');
    return 'failed';
  }
  if (cfData?.success && cfData.result?.status?.state === 'error') {
    lastCfCheck.delete(videoId);
    await markVideoFailed(videoId, video.cloudflare_video_id, String(cfData.result.status?.errorReasonCode ?? cfData.result.status?.errReasonCode ?? 'error'));
    return 'failed';
  }

  // Soubor k Cloudflare nikdy celý nedorazil (appka spadla uprostřed) - čekat dál nemá smysl.
  if (cfData?.success && uploadNeverFinished(cfData.result?.status?.state, video.created_at)) {
    lastCfCheck.delete(videoId);
    await markVideoFailed(videoId, video.cloudflare_video_id, 'nahrání u Cloudflare nedokončené');
    return 'failed';
  }

  if (!cfData.success || !cfData.result?.readyToStream) {
    // Jak daleko Cloudflare je - u dlouhého videa ať tvůrce vidí, že se to hýbe.
    const percent = processingPercent(cfData.result);
    lastCfCheck.set(videoId, { at: Date.now(), percent });
    if (progress) progress.percent = percent;
    return 'processing';
  }

  lastCfCheck.delete(videoId);
  await markVideoReady(videoId, cfData.result);
  return 'ready';
}

/**
 * Úklid zaseklých videí ("processing" déle než minutu).
 *
 * PROČ TO TU JE
 *
 * Doptávat se chodil jen prohlížeč tvůrce (stránka nahrávání, Tvoje videa,
 * stránka videa). Appka Kine do PC video nahrála, potvrdila - a nikdo se
 * už nezeptal, jestli je hotové. Na Cloudflare bylo v pořádku, na Kine
 * viselo jako "processing" a v žádném seznamu nebylo, dokud si tvůrce
 * neotevřel Tvoje videa. Bez webhooku od Cloudflare (který se musí
 * nastavit ručně) se to dřív nikdy samo nespravilo.
 *
 * Tohle projde zaseklá videa (starší než minutu - Cloudflare potřebuje
 * chvíli) a u každého se zeptá: nejvýš `max` nejnovějších z posledních
 * sedmi dnů a k tomu dvě nejstarší (jakkoli stará). Dřív jen nejstarší
 * z týdne - pár videí, která se u Cloudflare nikdy nedokončí, pak úklid
 * zablokovalo a nová nahrávání (klipy z mobilní appky) nenaskočila. Volá se z míst, kam chodí provoz i bez tvůrce (dotaz na stav,
 * záloha stránky videa, potvrzení nahrání, appka Kine do PC při startu),
 * ale nejvýš jednou za `THROTTLE_MS` na instanci - jinak by každý dotaz
 * platil daň za cizí videa. Denně to navíc pouští cron (vercel.json ->
 * /api/videos/sweep). Nikdy nehodí chybu - je to úklid, ne odpověď.
 */
const SWEEP_THROTTLE_MS = 90 * 1000;
let lastSweepAt = 0;
let sweeping: Promise<SweepResult> | null = null;

export type SweepResult = { checked: number; ready: number; skipped: boolean };

export async function sweepProcessing(options: { max?: number; force?: boolean } = {}): Promise<SweepResult> {
  const max = Math.max(1, Math.min(options.max ?? 4, 25));
  const now = Date.now();
  if (!options.force && now - lastSweepAt < SWEEP_THROTTLE_MS) return { checked: 0, ready: 0, skipped: true };
  // Dva souběžné dotazy nespustí dva úklidy - druhý počká na první.
  if (sweeping) return sweeping;
  lastSweepAt = now;
  sweeping = (async () => {
    const result: SweepResult = { checked: 0, ready: 0, skipped: false };
    try {
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const minuteAgo = new Date(now - 60 * 1000).toISOString();
      // Nejnovější z posledního týdne (na ty se čeká) + 2 nejstarší bez ohledu na stáří
      // (starší zaseklá se tak postupně dodělají nebo označí jako nepovedená).
      const stuck = (ascending: boolean, limit: number, since: string | null) => {
        let q = supabaseServer.from('videos').select('id').eq('status', 'processing').lte('created_at', minuteAgo);
        if (since) q = q.gte('created_at', since);
        return q.order('created_at', { ascending }).limit(limit);
      };
      const [newest, oldest] = await Promise.all([stuck(false, max, weekAgo), stuck(true, 2, null)]);
      for (const row of sweepOrder(newest.data, oldest.data)) {
        result.checked += 1;
        try {
          if ((await refreshFromCloudflare(row.id)) === 'ready') result.ready += 1;
        } catch {
          // Jedno video nejde ověřit (síť, Cloudflare) - další se zkusí dál.
        }
      }
      // Při té příležitosti oznámení naplánovaných videí, jejichž čas nastal,
      // a převzetí hotových automatických titulků.
      await sweepScheduled().catch(() => 0);
      await sweepCaptions().catch(() => 0);
      // Nedokončená nahrávání (lístek vypršel) a smazání u Cloudflare, která minule nevyšla.
      await expireTickets(options.force ? 20 : 3).catch(() => 0);
      await processCloudflareCleanup(options.force ? 20 : 3).catch(() => 0);
      // Opuštěná nahrání přímo podle Cloudflare (Pending Upload bez videa na Kine) - jen v důkladném úklidu.
      if (options.force) await sweepAbandonedUploads().catch(() => 0);
      // Vysílání: zablokované účty a nekonečné přenosy (lib/liveLimits.ts - sám si hlídá, jak často).
      await import('./liveLimits').then((m) => m.enforceLiveLimits({ force: options.force })).catch(() => undefined);
      // A na pozadí kontrola obsahu jednoho dvou starších videí (nejvýš jednou za 5 min).
      runInBackground(
        import('./nudityScan').then(({ sweepNudity }) => sweepNudity({ max: 2 })),
        'kontrola obsahu starších videí'
      );
    } catch {
      // Úklid nesmí shodit dotaz, ze kterého se volá.
    }
    return result;
  })();
  try {
    return await sweeping;
  } finally {
    sweeping = null;
  }
}
