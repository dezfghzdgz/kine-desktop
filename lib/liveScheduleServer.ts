import { supabaseServer } from './supabaseServer';
import { isMissingTable } from './apiUser';
import { SCHEDULE_GRACE_MS, scheduleCurrent } from './liveSchedule';

/**
 * Plánované vysílání - databázová část (pravidla v lib/liveSchedule.ts).
 * Tabulky live_schedules / live_reminders z supabase-migration-zive-raid-plan-ankety.sql;
 * bez migrace se nic neukazuje a nic nespadne.
 */

export type ChannelSchedule = { startsAt: string; title: string; game: string | null };

const CACHE_MS = 30 * 1000;
const cache = new Map<string, { at: number; value: ChannelSchedule | null }>();

/** Plán kanálu (jen platný - propadlý = null). Stránky se ptají často, server si ho 30 s pamatuje. */
export async function channelSchedule(ownerId: string): Promise<ChannelSchedule | null> {
  const hit = cache.get(ownerId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value && scheduleCurrent(hit.value.startsAt) ? hit.value : null;
  const { data, error } = await supabaseServer.from('live_schedules').select('starts_at, title, game').eq('owner_id', ownerId).maybeSingle();
  const row = !error && data ? (data as { starts_at: string; title: string | null; game: string | null }) : null;
  const value = row && scheduleCurrent(row.starts_at) ? { startsAt: row.starts_at, title: row.title ?? '', game: row.game ?? null } : null;
  cache.set(ownerId, { at: Date.now(), value });
  if (cache.size > 3000) cache.clear();
  return value;
}

/** Po změně plánu ve studiu (na této instanci serveru) hned čerstvý. */
export function forgetSchedule(ownerId: string): void {
  cache.delete(ownerId);
}

export type UpcomingStream = ChannelSchedule & {
  ownerId: string;
  profile: { id: string; username: string; displayName: string | null; avatarUrl: string | null; verificationTier: string | null };
};

let upcomingCache: { at: number; value: UpcomingStream[] } | null = null;

/**
 * Nejbližší plánovaná vysílání (stránka Živě - „Brzy živě“): do 7 dní,
 * bez zablokovaných a shadow-banovaných kanálů a bez těch, co už vysílají.
 * Minutu v paměti.
 */
export async function upcomingSchedules(limit = 12): Promise<UpcomingStream[] | null> {
  if (upcomingCache && Date.now() - upcomingCache.at < 60 * 1000) return upcomingCache.value.slice(0, limit);
  const now = Date.now();
  const { data, error } = await supabaseServer
    .from('live_schedules')
    .select('owner_id, starts_at, title, game')
    .gte('starts_at', new Date(now - SCHEDULE_GRACE_MS).toISOString())
    .lte('starts_at', new Date(now + 7 * 24 * 3600 * 1000).toISOString())
    .order('starts_at', { ascending: true })
    .limit(40);
  if (error) return isMissingTable(error) ? [] : null;
  const rows = (data ?? []) as { owner_id: string; starts_at: string; title: string | null; game: string | null }[];
  if (rows.length === 0) {
    upcomingCache = { at: now, value: [] };
    return [];
  }
  const ids = rows.map((r) => r.owner_id);
  const [profiles, live] = await Promise.all([
    supabaseServer.from('profiles').select('id, username, display_name, avatar_url, verification_tier, is_banned, is_shadow_banned').in('id', ids),
    supabaseServer.from('live_streams').select('owner_id').in('owner_id', ids).eq('is_live', true),
  ]);
  if (profiles.error) return null;
  const liveNow = new Set(((live.data ?? []) as { owner_id: string }[]).map((r) => r.owner_id));
  const byId = new Map(((profiles.data ?? []) as any[]).map((p) => [p.id as string, p]));
  const value: UpcomingStream[] = [];
  for (const r of rows) {
    const p = byId.get(r.owner_id);
    if (!p || p.is_banned || p.is_shadow_banned || liveNow.has(r.owner_id) || !p.username) continue;
    value.push({
      ownerId: r.owner_id,
      startsAt: r.starts_at,
      title: r.title ?? '',
      game: r.game ?? null,
      profile: { id: p.id, username: p.username, displayName: p.display_name ?? null, avatarUrl: p.avatar_url ?? null, verificationTier: p.verification_tier ?? null },
    });
  }
  upcomingCache = { at: now, value };
  return value.slice(0, limit);
}

/**
 * Vysílání právě začalo: kdo chtěl připomenout (id účtů) - a připomenutí
 * se tím spotřebují; plán, který tímhle vysíláním nastal, se smaže.
 * Když má kanál naplánované vysílání víc než 3 hodiny dopředu, je tohle
 * vysílání neplánované navíc - připomenutí počkají na to plánované.
 */
export async function takeReminders(ownerId: string): Promise<string[]> {
  const { data: plan, error: planError } = await supabaseServer.from('live_schedules').select('starts_at').eq('owner_id', ownerId).maybeSingle();
  if (planError && !isMissingTable(planError)) return [];
  const startsAt = (plan as { starts_at?: string } | null)?.starts_at;
  if (startsAt && Date.parse(startsAt) > Date.now() + 3 * 3600 * 1000) return [];
  // Smazání a výpis naráz - připomenutí přidané mezitím se nesmaže bez oznámení.
  const { data, error } = await supabaseServer.from('live_reminders').delete().eq('owner_id', ownerId).select('user_id');
  const ids = !error && data ? (data as { user_id: string }[]).map((r) => r.user_id) : [];
  if (startsAt) await supabaseServer.from('live_schedules').delete().eq('owner_id', ownerId);
  forgetSchedule(ownerId);
  upcomingCache = null;
  return ids;
}

/** Úklid (denně): propadlé plány, staré ankety (s hlasy), staré raidy a zapomenutá připomenutí. */
export async function sweepLiveExtras(): Promise<void> {
  const ago = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  await Promise.all([
    supabaseServer.from('live_schedules').delete().lt('starts_at', ago(1)),
    supabaseServer.from('live_polls').delete().lt('created_at', ago(30)),
    supabaseServer.from('live_raids').delete().lt('created_at', ago(90)),
    supabaseServer.from('live_reminders').delete().lt('created_at', ago(90)),
  ]).catch(() => undefined);
}
