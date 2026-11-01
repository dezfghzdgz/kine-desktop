import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { isMissingTable, userFromRequest } from '@/lib/apiUser';
import { REMINDERS_PER_USER, validateSchedule } from '@/lib/liveSchedule';
import { channelSchedule, forgetSchedule, upcomingSchedules } from '@/lib/liveScheduleServer';
import { allowRequest, tooManyRequests } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATION = 'Plánované vysílání ještě není v databázi zapnuté (spusť supabase-migration-zive-raid-plan-ankety.sql).';
const noStore = { 'Cache-Control': 'no-store' };
const fail = (status: number, error: string, code?: string) => NextResponse.json({ error, ...(code ? { code } : {}) }, { status, headers: noStore });

/**
 * Plánované vysílání (lib/liveSchedule.ts).
 *
 * GET ?upcoming=1            -> nejbližší plánovaná vysílání (stránka Živě; minutu v CDN)
 * GET ?mine=1               -> u kterých kanálů mám zapnuté připomenutí
 * GET ?channel=<id>          -> plán kanálu + jestli mám zapnuté připomenutí
 *                               (majitel i kolik lidí si ho zapnulo)
 * POST { action: 'set', startsAt, title?, game? }  -> majitel nastaví plán
 * POST { action: 'clear' }                         -> majitel plán zruší
 * POST { action: 'remind', channel, on }           -> divák zapne / vypne připomenutí
 *
 * Připomenutí: až kanál začne vysílat, přijde oznámení (i push) a připomenutí
 * se smaže (lib/liveStream.ts - notifyGoingLive).
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('upcoming') === '1') {
    const list = await upcomingSchedules(12);
    if (!list) return fail(503, 'Plánovaná vysílání se teď nepodařilo načíst.');
    return NextResponse.json({ upcoming: list }, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
  }

  if (params.get('mine') === '1') {
    // U kterých kanálů mám zapnuté připomenutí (seznam „Brzy živě“).
    const user = await userFromRequest(req);
    if (!user) return fail(401, 'Musíš být přihlášený.', 'auth');
    const { data } = await supabaseServer.from('live_reminders').select('owner_id').eq('user_id', user.id).limit(500);
    return NextResponse.json({ reminders: ((data ?? []) as { owner_id: string }[]).map((r) => r.owner_id) }, { headers: noStore });
  }

  const channel = params.get('channel') ?? '';
  if (!UUID.test(channel)) return fail(400, 'Neplatný kanál.');
  const id = channel.toLowerCase();
  const user = req.headers.get('authorization') ? await userFromRequest(req) : null;
  const [planned, { data: owner }] = await Promise.all([
    channelSchedule(id).catch(() => null),
    supabaseServer.from('profiles').select('is_banned, is_shadow_banned').eq('id', id).maybeSingle(),
  ]);
  // Zablokovaný / shadow-banovaný kanál plán ukazuje jen sám sobě (stejně jako přenos).
  const hidden = !owner || (owner as { is_banned?: boolean }).is_banned || (owner as { is_shadow_banned?: boolean }).is_shadow_banned;
  const schedule = hidden && user?.id !== id ? null : planned;
  let reminded: boolean | null = null;
  let reminders: number | null = null;
  if (user && user.id !== id) {
    const { data } = await supabaseServer.from('live_reminders').select('owner_id').eq('owner_id', id).eq('user_id', user.id).maybeSingle();
    reminded = !!data;
  }
  if (user && user.id === id) {
    const { count } = await supabaseServer.from('live_reminders').select('user_id', { count: 'exact', head: true }).eq('owner_id', id);
    reminders = count ?? 0;
  }
  return NextResponse.json({ schedule, reminded, reminders }, { headers: noStore });
}

export async function POST(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return fail(401, 'Musíš být přihlášený.', 'auth');
  if (!allowRequest(`live-schedule:${user.id}`, 20, 60 * 1000)) return tooManyRequests(20);
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  if (action === 'set' || action === 'clear') {
    // Plán smí mít jen kanál, který umí vysílat (má klíč ve studiu) a není zablokovaný.
    const [{ data: stream, error: streamError }, { data: me }] = await Promise.all([
      supabaseServer.from('live_streams').select('owner_id').eq('owner_id', user.id).maybeSingle(),
      supabaseServer.from('profiles').select('is_banned').eq('id', user.id).maybeSingle(),
    ]);
    if ((me as { is_banned?: boolean } | null)?.is_banned) return fail(403, 'Účet je zablokovaný.', 'banned');
    if (action === 'clear') {
      const { error } = await supabaseServer.from('live_schedules').delete().eq('owner_id', user.id);
      if (error && !isMissingTable(error)) return fail(500, 'Plán se nepodařilo zrušit.', 'db');
      forgetSchedule(user.id);
      return NextResponse.json({ ok: true, schedule: null }, { headers: noStore });
    }
    if (isMissingTable(streamError) || !stream) return fail(409, 'Nejdřív si ve studiu založ klíč pro vysílání.', 'no-input');
    const checked = validateSchedule({ startsAt: body?.startsAt, title: body?.title, game: body?.game });
    if (!checked.ok) {
      const text = checked.reason === 'time-past' ? 'Čas začátku musí být v budoucnosti.' : checked.reason === 'time-far' ? 'Naplánovat jde nejvýš 60 dní dopředu.' : 'Neplatný čas začátku.';
      return fail(400, text, checked.reason);
    }
    const { error } = await supabaseServer
      .from('live_schedules')
      .upsert({ owner_id: user.id, starts_at: checked.startsAt, title: checked.title, game: checked.game, updated_at: new Date().toISOString() }, { onConflict: 'owner_id' });
    if (error) return isMissingTable(error) ? fail(503, MIGRATION, 'not-configured') : fail(500, 'Plán se nepodařilo uložit.', 'db');
    forgetSchedule(user.id);
    return NextResponse.json({ ok: true, schedule: { startsAt: checked.startsAt, title: checked.title, game: checked.game } }, { headers: noStore });
  }

  if (action === 'remind') {
    const channel = typeof body?.channel === 'string' && UUID.test(body.channel) ? body.channel.toLowerCase() : null;
    if (!channel) return fail(400, 'Neplatný kanál.');
    if (channel === user.id) return fail(400, 'Na vlastní vysílání si připomenutí dát nejde.', 'self');
    if (body?.on === false) {
      const { error } = await supabaseServer.from('live_reminders').delete().eq('owner_id', channel).eq('user_id', user.id);
      if (error && !isMissingTable(error)) return fail(500, 'Připomenutí se nepodařilo vypnout.', 'db');
      return NextResponse.json({ ok: true, reminded: false }, { headers: noStore });
    }
    const [{ data: owner }, { count }] = await Promise.all([
      supabaseServer.from('profiles').select('id, is_banned').eq('id', channel).maybeSingle(),
      supabaseServer.from('live_reminders').select('owner_id', { count: 'exact', head: true }).eq('user_id', user.id),
    ]);
    if (!owner || (owner as { is_banned?: boolean }).is_banned) return fail(404, 'Kanál nenalezen.', 'not-found');
    if ((count ?? 0) >= REMINDERS_PER_USER) return fail(429, 'Máš zapnutých moc připomenutí - nějaké vypni.', 'limit');
    const { error } = await supabaseServer.from('live_reminders').upsert({ owner_id: channel, user_id: user.id }, { onConflict: 'owner_id,user_id', ignoreDuplicates: true });
    if (error) return isMissingTable(error) ? fail(503, MIGRATION, 'not-configured') : fail(500, 'Připomenutí se nepodařilo zapnout.', 'db');
    return NextResponse.json({ ok: true, reminded: true }, { headers: noStore });
  }

  return fail(400, 'Neznámá akce.');
}
