import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { isMissingTable, userFromRequest } from '@/lib/apiUser';
import { parseChatRoom } from '@/lib/liveChat';
import { activeBan, chatRole } from '@/lib/liveChatModeration';
import { pollActive, pollSummary, pollVisible, sanitizePoll, type PollRow, type PollSummary } from '@/lib/livePolls';
import { allowRequest, tooManyRequests } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATION = 'Ankety ještě nejsou v databázi zapnuté (spusť supabase-migration-zive-raid-plan-ankety.sql).';
const FIELDS = 'id, room, question, options, created_at, ends_at, closed_at';
const noStore = { 'Cache-Control': 'no-store' };
const fail = (status: number, error: string, code?: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...(code ? { code } : {}), ...extra }, { status, headers: noStore });

type Row = PollRow & { room: string };

/**
 * Počty hlasů si server 1,5 s pamatuje - u ankety se ptají všichni diváci
 * každé ~3 s, databáze dostane jeden dotaz místo stovek.
 */
const countsCache = new Map<string, { at: number; counts: { choice: number; votes: number }[] }>();
async function voteCounts(pollId: string, fresh = false): Promise<{ choice: number; votes: number }[]> {
  const hit = countsCache.get(pollId);
  if (!fresh && hit && Date.now() - hit.at < 1500) return hit.counts;
  const { data, error } = await supabaseServer.rpc('live_poll_counts', { p_poll: pollId });
  const counts = !error && Array.isArray(data) ? (data as { choice: number; votes: number }[]).map((r) => ({ choice: Number(r.choice), votes: Number(r.votes) })) : hit?.counts ?? [];
  countsCache.set(pollId, { at: Date.now(), counts });
  if (countsCache.size > 500) countsCache.clear();
  return counts;
}

/** Poslední anketa v chatu (i krátce po skončení - s výsledky). Taky 1,5 s v paměti. */
const roomCache = new Map<string, { at: number; row: Row | null }>();
async function latestPoll(room: string): Promise<{ row: Row | null; missing: boolean }> {
  const hit = roomCache.get(room);
  if (hit && Date.now() - hit.at < 1500) return { row: hit.row, missing: false };
  const { data, error } = await supabaseServer.from('live_polls').select(FIELDS).eq('room', room).order('created_at', { ascending: false }).limit(1);
  if (error) return { row: null, missing: isMissingTable(error) };
  const row = ((data ?? [])[0] as Row | undefined) ?? null;
  roomCache.set(room, { at: Date.now(), row });
  if (roomCache.size > 500) roomCache.clear();
  return { row, missing: false };
}

async function summary(row: Row, fresh = false): Promise<PollSummary & { room: string }> {
  return { ...pollSummary(row, await voteCounts(row.id, fresh)), room: row.room };
}

/** Kdo smí v chatu ankety zakládat a ukončovat: majitel kanálu, jeho moderátoři, tým Kine (ne zablokovaný účet). */
async function canManage(userId: string, room: string): Promise<boolean> {
  const parsed = parseChatRoom(room);
  if (!parsed || parsed.kind !== 'channel') return false;
  const [{ role }, { data: me }] = await Promise.all([chatRole(userId, parsed), supabaseServer.from('profiles').select('is_banned').eq('id', userId).maybeSingle()]);
  if ((me as { is_banned?: boolean } | null)?.is_banned) return false;
  return role !== 'viewer';
}

/**
 * Ankety v chatu živého vysílání (lib/livePolls.ts).
 *
 * GET ?room=channel:<id>  -> běžící / právě skončená anketa (null = žádná)
 * GET ?id=<anketa>        -> stav ankety (hlasy) - ptá se chat během ankety
 *   Obojí je pro všechny stejné (kdo jak hlasoval, se neposílá) - pár vteřin v CDN.
 * POST { action: 'create', room, question, options, seconds }  -> majitel / moderátor
 * POST { action: 'vote', id, choice }                          -> přihlášený divák, jednou
 * POST { action: 'end', id }                                   -> majitel / moderátor ukončí dřív
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const cache = { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=3' };
  const id = params.get('id');
  if (id) {
    if (!UUID.test(id)) return fail(400, 'Neplatná anketa.');
    const { data, error } = await supabaseServer.from('live_polls').select(FIELDS).eq('id', id).maybeSingle();
    if (error) return isMissingTable(error) ? NextResponse.json({ poll: null }, { headers: cache }) : fail(503, 'Anketu se teď nepodařilo načíst.');
    // Dávno skončená anketa (zpráva o ní je ještě v historii chatu) se znovu neukazuje.
    if (!data || !pollVisible(data as Row)) return NextResponse.json({ poll: null }, { headers: cache });
    return NextResponse.json({ poll: await summary(data as Row) }, { headers: cache });
  }
  const room = parseChatRoom(params.get('room'));
  if (!room || room.kind !== 'channel') return fail(400, 'Neplatný chat.');
  const { row } = await latestPoll(room.key);
  if (!row || !pollVisible(row)) return NextResponse.json({ poll: null }, { headers: cache });
  return NextResponse.json({ poll: await summary(row) }, { headers: cache });
}

export async function POST(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return fail(401, 'Musíš být přihlášený.', 'auth');
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  if (action === 'create') {
    if (!allowRequest(`live-poll-create:${user.id}`, 6, 60 * 1000)) return tooManyRequests(20);
    const room = parseChatRoom(body?.room);
    if (!room || room.kind !== 'channel') return fail(400, 'Ankety jdou jen v chatu živého vysílání.');
    if (!(await canManage(user.id, room.key))) return fail(403, 'Anketu může založit jen streamer nebo moderátor chatu.', 'forbidden');
    const checked = sanitizePoll(body ?? {});
    if (!checked.ok) {
      const text = checked.reason === 'question' ? 'Napiš otázku.' : checked.reason === 'duplicate' ? 'Možnosti se nesmí opakovat.' : 'Anketa potřebuje 2 až 4 možnosti.';
      return fail(400, text, checked.reason);
    }
    const { row: last, missing } = await latestPoll(room.key);
    if (missing) return fail(503, MIGRATION, 'not-configured');
    // Nová anketa nejdřív 10 s po předchozí (dvojklik, spam ze skriptu).
    if (last && Date.now() - Date.parse(last.created_at) < 10 * 1000) return fail(429, 'Novou anketu jde založit za pár vteřin.', 'busy', { retryS: 10 });
    const now = new Date();
    // Běžící anketa v tomhle chatu končí - naráz běží jen jedna.
    await supabaseServer.from('live_polls').update({ closed_at: now.toISOString() }).eq('room', room.key).is('closed_at', null).gt('ends_at', now.toISOString());
    const { data, error } = await supabaseServer
      .from('live_polls')
      .insert({ room: room.key, created_by: user.id, question: checked.question, options: checked.options, ends_at: new Date(now.getTime() + checked.seconds * 1000).toISOString() })
      .select(FIELDS)
      .single();
    if (error || !data) return isMissingTable(error) ? fail(503, MIGRATION, 'not-configured') : fail(500, 'Anketu se nepodařilo založit.', 'db');
    roomCache.delete(room.key);
    const row = data as Row;
    // Zpráva do chatu - podle ní chat u všech hned pozná, že je nová anketa.
    const chat = await supabaseServer.from('live_chat_messages').insert({ room: room.key, user_id: user.id, body: `📊 ${checked.question}`, kind: 'poll', meta: { poll: row.id } });
    if (chat.error) console.error('Kine: anketa - zpráva do chatu', chat.error.message);
    return NextResponse.json({ poll: await summary(row, true) }, { headers: noStore });
  }

  const id = typeof body?.id === 'string' && UUID.test(body.id) ? body.id : null;
  if (!id) return fail(400, 'Neplatná anketa.');
  const { data, error } = await supabaseServer.from('live_polls').select(FIELDS).eq('id', id).maybeSingle();
  if (error) return isMissingTable(error) ? fail(503, MIGRATION, 'not-configured') : fail(503, 'Anketu se teď nepodařilo načíst.');
  if (!data) return fail(404, 'Anketa nenalezena.', 'not-found');
  const row = data as Row;

  if (action === 'vote') {
    if (!allowRequest(`live-poll-vote:${user.id}`, 20, 60 * 1000)) return tooManyRequests(10);
    if (!pollActive(row)) return fail(409, 'Anketa už skončila.', 'ended', { poll: await summary(row) });
    const choice = Number(body?.choice);
    const options = Array.isArray(row.options) ? row.options.length : 0;
    if (!Number.isInteger(choice) || choice < 0 || choice >= options) return fail(400, 'Neplatná možnost.');
    const [{ data: me }, ban] = await Promise.all([
      supabaseServer.from('profiles').select('is_banned').eq('id', user.id).maybeSingle(),
      activeBan(row.room, user.id),
    ]);
    if ((me as { is_banned?: boolean } | null)?.is_banned || ban) return fail(403, 'V tomhle chatu teď hlasovat nemůžeš.', 'banned');
    const { error: voteError } = await supabaseServer.from('live_poll_votes').insert({ poll_id: row.id, user_id: user.id, choice });
    if (voteError) {
      if (voteError.code === '23505') {
        // Už hlasoval - vrátí se jeho hlas (stránka si ho po obnovení nepamatuje).
        const { data: mine } = await supabaseServer.from('live_poll_votes').select('choice').eq('poll_id', row.id).eq('user_id', user.id).maybeSingle();
        return NextResponse.json({ ok: true, already: true, choice: (mine as { choice?: number } | null)?.choice ?? null, poll: await summary(row) }, { headers: noStore });
      }
      return fail(500, 'Hlas se nepodařilo uložit.', 'db');
    }
    return NextResponse.json({ ok: true, choice, poll: await summary(row, true) }, { headers: noStore });
  }

  if (action === 'end') {
    if (!(await canManage(user.id, row.room))) return fail(403, 'Anketu může ukončit jen streamer nebo moderátor chatu.', 'forbidden');
    if (pollActive(row)) {
      const closedAt = new Date().toISOString();
      await supabaseServer.from('live_polls').update({ closed_at: closedAt }).eq('id', row.id);
      row.closed_at = closedAt;
      roomCache.delete(row.room);
    }
    return NextResponse.json({ poll: await summary(row, true) }, { headers: noStore });
  }

  return fail(400, 'Neznámá akce.');
}
