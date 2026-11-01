import { supabaseServer } from './supabaseServer';
import { isMissingTable } from './apiUser';
import { hasKinePlus } from './plus';
import { NO_USAGE, ticketUsage, uploadLimitsFor, type TicketRow, type UploadLimits, type UploadUsage } from './uploadLimits';
import { cloudflareUidInUse, deleteOrQueue, deleteStreamVideo, getStreamVideo, isCloudflareUid } from './cloudflareVideos';

/**
 * Lístky na nahrání (tabulka upload_tickets, migrace
 * supabase-migration-zabezpeceni-a-limity.sql).
 *
 * Kdo chce nahrát video, dostane od /api/videos/create-upload-url jednorázovou
 * adresu u Cloudflare - a k ní lístek: kdo, kdy, kolik minut si zarezervoval.
 * /api/videos/confirm pak uloží video JEN s platným lístkem toho samého
 * člověka. Dřív šlo do confirm poslat libovolné id videa u Cloudflare (třeba
 * cizí záznam vysílání), mít ho pod sebou a pak smazáním smazat originál.
 *
 * Nedokončená nahrávání (lístek bez potvrzení) úklid po LÍSTEK_PLATÍ_H
 * hodinách u Cloudflare smaže - jinak by tam ležela napořád a platila by se
 * (a šla by pustit přímou adresou: úložiště zadarmo).
 */

/** Jak dlouho čeká lístek na potvrzení (appka do PC nahrává po kouskách mezi hrami). */
export const TICKET_VALID_HOURS = 24;

export type TicketClaim =
  | { kind: 'claimed'; ticketId: string; reservedSeconds: number }
  | { kind: 'already'; ticketId: string; videoId: string | null }
  | { kind: 'not-found' }
  | { kind: 'other-user' }
  | { kind: 'expired' }
  | { kind: 'no-table' }
  | { kind: 'error'; message: string };

type Profile = { plan?: string | null; plan_until?: string | null; role?: string | null; is_admin?: boolean | null; is_banned?: boolean | null };

/** Profil pro limity (sloupce z různých migrací - co chybí, se vynechá). */
export async function uploadProfile(userId: string): Promise<Profile | null> {
  const full = await supabaseServer.from('profiles').select('plan, plan_until, role, is_admin, is_banned').eq('id', userId).maybeSingle();
  if (!full.error) return (full.data as Profile | null) ?? null;
  const basic = await supabaseServer.from('profiles').select('role, is_banned').eq('id', userId).maybeSingle();
  if (!basic.error) return (basic.data as Profile | null) ?? null;
  const min = await supabaseServer.from('profiles').select('id').eq('id', userId).maybeSingle();
  return min.data ? {} : null;
}

export function limitsForProfile(profile: Profile | null, accountCreatedAt: string | null): UploadLimits {
  const staff = profile?.role === 'moderator' || profile?.role === 'admin' || profile?.is_admin === true;
  return uploadLimitsFor({ staff, plus: hasKinePlus(profile?.plan, profile?.plan_until), accountCreatedAt }, process.env);
}

/** Kolik toho člověk nahrál (24 h, rozpracované, celé úložiště). */
export async function uploadUsage(userId: string): Promise<{ usage: UploadUsage; tickets: boolean }> {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();
  // Minuty a úložiště spočítá databáze (potřebuje skutečné délky videí); počty z lístků
  // tady (klipy zvlášť, zrušená nahrání se nepočítají, opuštěná nedrží místo napořád).
  const [rpc, list] = await Promise.all([
    supabaseServer.rpc('kine_upload_usage', { p_user: userId }),
    supabaseServer
      .from('upload_tickets')
      .select('status, declared_seconds, reserved_seconds, created_at, expires_at')
      .eq('user_id', userId)
      .or(`created_at.gt.${dayAgo},and(status.eq.pending,expires_at.gt.${nowIso})`)
      .limit(5000),
  ]);
  if (!rpc.error && rpc.data && typeof rpc.data === 'object') {
    const d = rpc.data as Record<string, unknown>;
    const n = (k: string) => (Number.isFinite(Number(d[k])) ? Math.max(0, Number(d[k])) : 0);
    const base: UploadUsage = {
      ...NO_USAGE,
      uploadsToday: n('uploadsToday'),
      attemptsToday: n('uploadsToday'),
      secondsToday: n('secondsToday'),
      pending: n('pending'),
      pendingSeconds: n('pendingSeconds'),
      storedSeconds: n('storedSeconds'),
    };
    if (!list.error && Array.isArray(list.data)) {
      return { usage: { ...base, ...ticketUsage(list.data as TicketRow[], now) }, tickets: true };
    }
    return { usage: base, tickets: true };
  }
  // Bez migrace: jako dřív - počítají se videa za posledních 24 hodin (bez klipů od diváků, i z vysílání).
  const since = Date.now() - 24 * 3600 * 1000;
  let rows: { duration_seconds: number | null; created_at: string }[] = [];
  const withoutClips = await supabaseServer
    .from('videos')
    .select('duration_seconds, created_at')
    .eq('owner_id', userId)
    .is('clipped_from_video_id', null)
    .is('clipped_by', null)
    .limit(5000);
  if (!withoutClips.error) rows = (withoutClips.data as typeof rows) ?? [];
  else rows = (((await supabaseServer.from('videos').select('duration_seconds, created_at').eq('owner_id', userId).limit(5000)).data as typeof rows) ?? []);
  const today = rows.filter((r) => Date.parse(r.created_at) >= since);
  return {
    usage: {
      ...NO_USAGE,
      uploadsToday: today.length,
      secondsToday: today.reduce((s, r) => s + (r.duration_seconds ?? 0), 0),
      storedSeconds: rows.reduce((s, r) => s + (r.duration_seconds ?? 0), 0),
    },
    tickets: false,
  };
}

/** Zapíše lístek k nově založenému nahrávání u Cloudflare. */
export async function createTicket(input: {
  userId: string;
  cfUid: string;
  reservedSeconds: number;
  declaredSeconds: number | null;
  fileBytes: number | null;
  source: string;
}): Promise<{ ok: true } | { ok: false; missingTable: boolean; message: string }> {
  const { error } = await supabaseServer.from('upload_tickets').insert({
    user_id: input.userId,
    cf_uid: input.cfUid,
    reserved_seconds: Math.round(input.reservedSeconds),
    declared_seconds: input.declaredSeconds === null ? null : Math.round(input.declaredSeconds),
    file_bytes: input.fileBytes && input.fileBytes > 0 ? Math.round(input.fileBytes) : null,
    source: input.source.slice(0, 40),
    expires_at: new Date(Date.now() + TICKET_VALID_HOURS * 3600 * 1000).toISOString(),
  });
  if (error) return { ok: false, missingTable: isMissingTable(error), message: error.message };
  return { ok: true };
}

/** Uplatní lístek při potvrzení nahrání (jen vlastní, jen jednou). */
export async function claimTicket(userId: string, cfUid: string): Promise<TicketClaim> {
  const nowIso = new Date().toISOString();
  const claimed = await supabaseServer
    .from('upload_tickets')
    .update({ status: 'used', used_at: nowIso })
    .eq('cf_uid', cfUid)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id, reserved_seconds');
  if (claimed.error) return isMissingTable(claimed.error) ? { kind: 'no-table' } : { kind: 'error', message: claimed.error.message };
  const row = (claimed.data as { id: string; reserved_seconds: number }[] | null)?.[0];
  if (row) return { kind: 'claimed', ticketId: row.id, reservedSeconds: row.reserved_seconds };

  const existing = await supabaseServer.from('upload_tickets').select('id, user_id, status, video_id').eq('cf_uid', cfUid).maybeSingle();
  if (existing.error) return { kind: 'error', message: existing.error.message };
  const t = existing.data as { id: string; user_id: string; status: string; video_id: string | null } | null;
  if (!t) return { kind: 'not-found' };
  if (t.user_id !== userId) return { kind: 'other-user' };
  if (t.status === 'used') return { kind: 'already', ticketId: t.id, videoId: t.video_id };
  return { kind: 'expired' };
}

export async function attachVideoToTicket(ticketId: string, videoId: string): Promise<void> {
  await supabaseServer.from('upload_tickets').update({ video_id: videoId }).eq('id', ticketId).then(
    () => undefined,
    () => undefined
  );
}

/**
 * Nahrání bez lístku (založené před nasazením téhle verze): smí se uložit jen
 * čerstvé video, které u Cloudflare opravdu je, není to záznam vysílání a
 * nepatří nikomu jinému. Nová nahrávání mají u Cloudflare "creator" = id
 * uživatele - cizí se tak pozná i bez lístku.
 */
export async function legacyUploadAllowed(userId: string, cfUid: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const video = await getStreamVideo(cfUid);
  if (video === undefined) return { ok: false, message: 'Cloudflare teď neodpovídá - zkus uložení videa za chvíli znovu.' };
  if (video === null) return { ok: false, message: 'Tohle nahrání u Cloudflare není.' };
  if (video.liveInput) return { ok: false, message: 'Záznam vysílání se ukládá ve studiu (Živě), ne tudy.' };
  if (typeof video.creator === 'string' && video.creator) {
    return video.creator === userId ? { ok: true } : { ok: false, message: 'Tohle nahrání patří někomu jinému.' };
  }
  const created = Date.parse(String(video.created ?? video.uploaded ?? ''));
  if (!Number.isFinite(created) || Date.now() - created > TICKET_VALID_HOURS * 3600 * 1000) {
    return { ok: false, message: 'Nahrání je moc staré nebo neznámé - nahraj video znovu.' };
  }
  return { ok: true };
}

/**
 * Úklid: nedokončená nahrávání po vypršení lístku smazat u Cloudflare
 * (nejvýš `max` naráz). Nikdy nehodí chybu.
 */
export async function expireTickets(max = 10): Promise<number> {
  let expired = 0;
  try {
    const { data, error } = await supabaseServer
      .from('upload_tickets')
      .select('id, cf_uid')
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: true })
      .limit(max);
    if (error || !data) return 0;
    for (const t of data as { id: string; cf_uid: string }[]) {
      // Video se mezitím uložilo jinou cestou (stará appka, ruční oprava)? Pak lístek jen dorovnat.
      if (await cloudflareUidInUse(t.cf_uid)) {
        const { data: v } = await supabaseServer.from('videos').select('id').eq('cloudflare_video_id', t.cf_uid).limit(1);
        await supabaseServer.from('upload_tickets').update({ status: 'used', video_id: (v as { id: string }[] | null)?.[0]?.id ?? null }).eq('id', t.id);
        continue;
      }
      if (isCloudflareUid(t.cf_uid)) await deleteOrQueue(t.cf_uid, 'nedokončené nahrání (lístek vypršel)');
      await supabaseServer.from('upload_tickets').update({ status: 'expired' }).eq('id', t.id).eq('status', 'pending');
      expired += 1;
    }
  } catch {
    // Úklid nesmí shodit dotaz, ze kterého se volá.
  }
  return expired;
}

export type CancelOutcome = 'canceled' | 'already' | 'used' | 'not-found' | 'other-user' | 'error';

/**
 * Zrušení nahrávání (tlačítko Zrušit v appce, nebo appka / stránka po
 * nepovedeném pokusu): lístek se uvolní (status "failed" - do denního počtu
 * se nepočítá) a rezerva u Cloudflare se hned smaže. Hotové video (lístek
 * "used") se tudy nesmaže - na to je /api/videos/delete.
 */
export async function cancelTicket(userId: string, cfUid: string): Promise<CancelOutcome> {
  if (!isCloudflareUid(cfUid)) return 'not-found';
  const updated = await supabaseServer
    .from('upload_tickets')
    .update({ status: 'failed' })
    .eq('cf_uid', cfUid)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id');
  if (!updated.error && (updated.data ?? []).length > 0) {
    await deleteOrQueue(cfUid, 'nahrání zrušené');
    return 'canceled';
  }
  if (updated.error && !isMissingTable(updated.error)) return 'error';

  if (!updated.error) {
    const existing = await supabaseServer.from('upload_tickets').select('user_id, status').eq('cf_uid', cfUid).maybeSingle();
    if (existing.error) return 'error';
    const t = existing.data as { user_id: string; status: string } | null;
    if (t) {
      if (t.user_id !== userId) return 'other-user';
      if (t.status === 'used') return 'used';
      // Už zrušené / vypršelé - co u Cloudflare případně zbylo, pryč (jen nepoužité).
      await deleteOrQueue(cfUid, 'nahrání zrušené');
      return 'already';
    }
  }

  // Bez lístku (nahrávání z doby před lístky, nebo bez migrace): jen vlastní a nepoužité.
  const video = await getStreamVideo(cfUid);
  if (video === undefined) return 'error';
  if (video === null) return 'already';
  if (video.liveInput || typeof video.creator !== 'string' || video.creator !== userId) return 'other-user';
  if (await cloudflareUidInUse(cfUid)) return 'used';
  const outcome = await deleteStreamVideo(cfUid);
  return outcome === 'failed' ? 'error' : 'canceled';
}

/** Zpracování u Cloudflare selhalo (třeba delší video, než se ohlásilo) - lístek se uvolní. */
export async function markTicketFailed(cfUid: string): Promise<void> {
  await supabaseServer.from('upload_tickets').update({ status: 'failed' }).eq('cf_uid', cfUid).in('status', ['pending', 'used']).then(
    () => undefined,
    () => undefined
  );
}
