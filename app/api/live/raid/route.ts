import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { isMissingTable, userFromRequest } from '@/lib/apiUser';
import type { LiveStreamRow } from '@/lib/liveStream';
import { liveHiddenNow } from '@/lib/nudityRules';
import { channelRoom } from '@/lib/liveChat';
import { activeBan } from '@/lib/liveChatModeration';
import { cachedLiveViewers } from '@/lib/liveStats';
import { raidActive, raidAllowed, raidChatBody } from '@/lib/liveRaid';
import { allowRequest, tooManyRequests } from '@/lib/rateLimit';
import { lockKey, withUserLock } from '@/lib/userLock';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATION = 'Raid ještě není v databázi zapnutý (spusť supabase-migration-zive-raid-plan-ankety.sql).';
const noStore = { 'Cache-Control': 'no-store' };
const fail = (status: number, error: string, code?: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...(code ? { code } : {}), ...extra }, { status, headers: noStore });

type ProfileRow = { id: string; username: string | null; display_name: string | null; avatar_url: string | null; is_banned?: boolean | null; is_shadow_banned?: boolean | null };

/** Chybí sloupec raid_to / raid_at (migrace ještě neproběhla)? */
function missingRaidColumns(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204' || /raid_to|raid_at/i.test(error.message ?? ''));
}

/**
 * Raid (lib/liveRaid.ts): POST { target } - streamer na konci vysílání
 * pošle diváky ke kanálu, který právě vysílá. Stránka jeho přenosu je
 * za pár vteřin přesune (app/api/live/status vrací "raid"); do chatu
 * cílového kanálu přijde zpráva „⚡ Raid!“ a jeho majitel oznámení.
 *
 * Pravidla: posílat jde jen během vlastního vysílání, cíl musí vysílat
 * a být vidět (ne zablokovaný / skrytý), nejvýš jeden raid za 5 minut
 * a ke stejnému kanálu nejvýš 3× za den; kdo má v chatu cíle zákaz,
 * raid tam poslat nemůže.
 *
 * DELETE zruší raid, dokud diváci ještě nejsou přesunutí (překlep).
 */
export async function POST(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return fail(401, 'Musíš být přihlášený.', 'auth');
  if (!allowRequest(`live-raid:${user.id}`, 6, 60 * 1000)) return tooManyRequests(30);

  const body = await req.json().catch(() => ({}));
  const target = typeof body?.target === 'string' && UUID.test(body.target) ? body.target.toLowerCase() : null;
  if (!target) return fail(400, 'Neplatný kanál.');
  if (target === user.id) return fail(400, 'Raid sám sobě poslat nejde.', 'self');

  const [mineRes, theirsRes, profilesRes] = await Promise.all([
    supabaseServer.from('live_streams').select('*').eq('owner_id', user.id).maybeSingle(),
    supabaseServer.from('live_streams').select('*').eq('owner_id', target).maybeSingle(),
    supabaseServer.from('profiles').select('id, username, display_name, avatar_url, is_banned, is_shadow_banned').in('id', [user.id, target]),
  ]);
  if (isMissingTable(mineRes.error)) return fail(503, 'Živé vysílání ještě není v databázi zapnuté.', 'not-configured');
  const mine = mineRes.data as LiveStreamRow | null;
  const theirs = theirsRes.data as LiveStreamRow | null;
  const people = (profilesRes.data ?? []) as ProfileRow[];
  const me = people.find((p) => p.id === user.id);
  const them = people.find((p) => p.id === target);

  if (!mine || !mine.is_live) return fail(409, 'Raid jde poslat jen během vysílání.', 'not-live');
  // Zablokovaný ani shadow-banovaný kanál raid neposílá (jinde ho nikdo nevidí - neměl by ani tady).
  if (!me || me.is_banned || me.is_shadow_banned || liveHiddenNow(mine as any)) return fail(403, 'Raid teď poslat nejde.', 'unavailable');
  if (!theirs || !theirs.is_live || !them || them.is_banned || them.is_shadow_banned || liveHiddenNow(theirs as any)) {
    return fail(409, 'Tenhle kanál teď nevysílá.', 'target-offline');
  }
  // Cíl právě sám posílá diváky dál - raid by je jen přehodil jinam (a dva raidy proti sobě by diváky honily dokola).
  if (raidActive(theirs as any)) return fail(409, 'Tenhle kanál právě sám posílá diváky jinam.', 'target-raiding');
  if (await activeBan(channelRoom(target), user.id)) return fail(403, 'V chatu tohohle kanálu máš zákaz - raid tam poslat nejde.', 'blocked');

  // Kontrola limitů a zápis pod zámkem (lib/userLock.ts) - souběžné požadavky by jinak prošly všechny.
  const locked = await withUserLock(
    lockKey('raid', user.id),
    async () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const [last, pair] = await Promise.all([
        supabaseServer.from('live_raids').select('created_at').eq('from_owner', user.id).order('created_at', { ascending: false }).limit(1),
        supabaseServer.from('live_raids').select('id', { count: 'exact', head: true }).eq('from_owner', user.id).eq('to_owner', target).gte('created_at', since),
      ]);
      if (isMissingTable(last.error)) return fail(503, MIGRATION, 'not-configured');
      if (last.error || pair.error) return fail(503, 'Raid teď poslat nejde - zkus to za chvíli.', 'db');
      const allowed = raidAllowed(last.data?.[0]?.created_at ?? null, pair.count ?? 0);
      if (!allowed.ok) {
        return allowed.reason === 'cooldown'
          ? fail(429, 'Další raid jde poslat až za chvíli.', 'cooldown', { retryS: allowed.retryS })
          : fail(429, 'K tomuhle kanálu jsi dnes poslal raid už několikrát.', 'pair-limit');
      }

      const viewers = await cachedLiveViewers(mine.cf_input_id).catch(() => null);
      const count = typeof viewers === 'number' ? viewers : null;
      // Nejdřív záznam raidu (podle něj se počítají limity) - když nevyjde, nic dalšího se neděje.
      const logged = await supabaseServer.from('live_raids').insert({ from_owner: user.id, to_owner: target, viewers: count });
      if (logged.error) {
        console.error('Kine: raid se nezapsal -', logged.error.message);
        return fail(500, 'Raid se nepodařilo poslat.', 'db');
      }
      const at = new Date().toISOString();
      const marked = await supabaseServer.from('live_streams').update({ raid_to: target, raid_at: at }).eq('owner_id', user.id);
      if (marked.error) {
        if (missingRaidColumns(marked.error)) return fail(503, MIGRATION, 'not-configured');
        console.error('Kine: raid se nezapsal -', marked.error.message);
        return fail(500, 'Raid se nepodařilo poslat.', 'db');
      }

      // Zpráva do chatu cílového kanálu (text pro starší stránky; nové ji poskládají v jazyce diváka).
      const name = me.display_name || me.username || 'Kine';
      const chat = await supabaseServer.from('live_chat_messages').insert({
        room: channelRoom(target),
        user_id: user.id,
        body: raidChatBody(name, count),
        kind: 'raid',
        meta: { raid: { viewers: count } },
      });
      if (chat.error) console.error('Kine: raid - zpráva do chatu', chat.error.message);
      // Oznámení majiteli cílového kanálu (zvoneček; na telefon ne - u vysílání má chat před sebou).
      const note = await supabaseServer.from('notifications').insert({
        user_id: target,
        type: 'default',
        sender_id: user.id,
        message: count && count > 0 ? `⚡ ${name} k tobě poslal raid (${count} diváků)` : `⚡ ${name} k tobě poslal raid`,
        link: `/live/${target}`,
      });
      if (note.error) console.error('Kine: raid - oznámení', note.error.message);

      return NextResponse.json(
        { ok: true, raid: { at, viewers: count, to: { id: them.id, username: them.username, display_name: them.display_name, avatar_url: them.avatar_url } } },
        { headers: noStore }
      );
    },
    { waitMs: 5000 }
  );
  if (!locked.ok) return fail(429, 'Raid se právě posílá - zkus to za pár sekund.', 'busy', { retryS: 3 });
  return locked.value;
}

export async function DELETE(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return fail(401, 'Musíš být přihlášený.', 'auth');
  const { data, error } = await supabaseServer.from('live_streams').select('*').eq('owner_id', user.id).maybeSingle();
  if (error || !data) return fail(404, 'Přenos nenalezen.', 'not-found');
  const row = data as LiveStreamRow & { raid_to?: string | null; raid_at?: string | null };
  if (!raidActive(row) || !row.raid_to || !row.raid_at) return NextResponse.json({ ok: true, cancelled: false }, { headers: noStore });
  const target = row.raid_to;
  const since = row.raid_at;
  const cleared = await supabaseServer.from('live_streams').update({ raid_to: null, raid_at: null }).eq('owner_id', user.id);
  if (cleared.error) return fail(500, 'Raid se nepodařilo zrušit.', 'db');
  // Omylem poslaný raid po sobě nenechá stopy: zprávu v cizím chatu ani oznámení jeho majiteli.
  await Promise.all([
    supabaseServer.from('live_chat_messages').delete().eq('room', channelRoom(target)).eq('user_id', user.id).eq('kind', 'raid').gte('created_at', since),
    supabaseServer.from('notifications').delete().eq('user_id', target).eq('sender_id', user.id).eq('link', `/live/${target}`).gte('created_at', since),
  ]).catch(() => undefined);
  return NextResponse.json({ ok: true, cancelled: true }, { headers: noStore });
}
