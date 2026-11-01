import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { isMissingTable, isStaffUser, userFromRequest } from '@/lib/apiUser';
import { LIST_SYNC_BUDGET_MS, publicLive, syncLiveStreamsForViewers, type LiveStreamRow } from '@/lib/liveStream';
import type { LiveRestriction } from '@/lib/liveNow';
import { liveHiddenNow } from '@/lib/nudityRules';
import { runInBackground } from '@/lib/background';
import { CREATOR_PAYMENTS_ENABLED } from '@/lib/payments';
import { tipTarget } from '@/lib/liveTipsServer';
import { tipFeePercent } from '@/lib/liveTips';
import { peekLiveViewers, sampleLiveRow } from '@/lib/liveStats';
import { raidActive } from '@/lib/liveRaid';
import { channelSchedule, type ChannelSchedule } from '@/lib/liveScheduleServer';

export const dynamic = 'force-dynamic';
// Na pozadí může běžet kontrola obsahu (lib/nudityScan.ts) - funkce smí doběhnout až minutu.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Přijímá kanál podpory? Stránka se ptá každých 6 s - odpověď si server minutu pamatuje. */
const tipsCache = new Map<string, { at: number; enabled: boolean }>();
async function tipsEnabled(channel: string): Promise<boolean> {
  const hit = tipsCache.get(channel);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.enabled;
  const enabled = (await tipTarget(channel).catch(() => ({ ok: false }))).ok;
  tipsCache.set(channel, { at: Date.now(), enabled });
  if (tipsCache.size > 2000) tipsCache.clear();
  return enabled;
}

/**
 * Záznam posledního vysílání kanálu (veřejné video vzniklé ze záznamu); bez
 * migrace zive-2 nic. Podle začátku vysílání, ne podle zveřejnění, a i když
 * se ještě zpracovává (hned po konci) - jinak by odkaz vedl na předchozí
 * vysílání. Minutu v paměti.
 */
const recordingCache = new Map<string, { at: number; value: { id: string; title: string; thumbnailUrl: string | null } | null }>();
async function latestRecording(channel: string): Promise<{ id: string; title: string; thumbnailUrl: string | null } | null> {
  const hit = recordingCache.get(channel);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.value;
  const { data, error } = await supabaseServer
    .from('videos')
    .select('id, title, thumbnail_url')
    .eq('owner_id', channel)
    .in('status', ['ready', 'processing'])
    .eq('visibility', 'public')
    .not('live_started_at', 'is', null)
    .order('live_started_at', { ascending: false })
    .limit(1);
  const row = !error && data && data[0] ? data[0] : null;
  const value = row ? { id: String(row.id), title: String(row.title ?? ''), thumbnailUrl: typeof row.thumbnail_url === 'string' ? row.thumbnail_url : null } : null;
  recordingCache.set(channel, { at: Date.now(), value });
  if (recordingCache.size > 2000) recordingCache.clear();
  return value;
}

type RaidInfo = { at: string; to: { id: string; username: string | null; display_name: string | null; avatar_url: string | null } };

/**
 * Raid (app/api/live/raid): kanál právě poslal diváky jinam - stránka přenosu
 * je tam za pár vteřin přesune. Cíl musí pořád být vidět (ne zablokovaný).
 */
async function raidInfo(row: LiveStreamRow): Promise<RaidInfo | null> {
  const r = row as LiveStreamRow & { raid_to?: string | null; raid_at?: string | null };
  if (!raidActive(r)) return null;
  const [{ data }, { data: targetStream }] = await Promise.all([
    supabaseServer.from('profiles').select('id, username, display_name, avatar_url, is_banned, is_shadow_banned').eq('id', r.raid_to!).maybeSingle(),
    supabaseServer.from('live_streams').select('*').eq('owner_id', r.raid_to!).maybeSingle(),
  ]);
  const p = data as (RaidInfo['to'] & { is_banned?: boolean; is_shadow_banned?: boolean }) | null;
  if (!p || p.is_banned || p.is_shadow_banned) return null;
  // Cíl mezitím skončil, je skrytý kontrolou obsahu, nebo sám poslal raid dál - nikam nepřesouvat.
  const t = targetStream as (LiveStreamRow & Record<string, any>) | null;
  if (!t || !t.is_live || liveHiddenNow(t as any) || raidActive(t)) return null;
  return { at: r.raid_at!, to: { id: p.id, username: p.username, display_name: p.display_name, avatar_url: p.avatar_url } };
}

/**
 * Je kanál živě? Stránka přenosu (/live/[id]) a odznak na kanálu se ptají
 * odsud. Stav se srovná s Cloudflare (nejvýš jednou za pár vteřin pro
 * všechny kanály naráz - lib/liveStream.ts).
 */
export async function GET(req: NextRequest) {
  const channel = req.nextUrl.searchParams.get('channel') ?? '';
  // Hlavičku Cache-Control si tahle cesta nastavuje sama (next.config.js ji vynechává) -
  // do mezipaměti CDN smí jen úspěšná odpověď pro nepřihlášené (dole), jinak vždy no-store.
  if (!UUID.test(channel)) return NextResponse.json({ error: 'Neplatný kanál.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  // Srovnání s Cloudflare na pozadí - stránka se ptá každých pár vteřin, stav v databázi drží appka.
  await syncLiveStreamsForViewers(LIST_SYNC_BUDGET_MS);
  const [{ data: row, error }, { data: profile }] = await Promise.all([
    supabaseServer.from('live_streams').select('*').eq('owner_id', channel).maybeSingle(),
    supabaseServer.from('profiles').select('id, username, display_name, avatar_url, verification_tier, is_banned, is_shadow_banned').eq('id', channel).maybeSingle(),
  ]);
  const { is_banned: banned, is_shadow_banned: shadowBanned, ...publicProfile } = (profile ?? {}) as Record<string, any>;
  if (isMissingTable(error)) return NextResponse.json({ enabled: false, live: false, profile: profile ? publicProfile : null }, { headers: { 'Cache-Control': 'no-store' } });
  // Výpadek databáze: chyba, ne "nevysílá" - stránka přenosu si nechá poslední stav.
  if (error) return NextResponse.json({ error: 'Stav přenosu se teď nepodařilo načíst.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  if (!profile) return NextResponse.json({ error: 'Kanál nenalezen.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  // Kdo se ptá a jestli je z týmu Kine - zjišťuje se jen když je to potřeba
  // (stránka se ptá často, ověření přihlášení stojí dotaz na Supabase).
  let requester: { id: string } | null | undefined;
  const who = async () => (requester === undefined ? (requester = await userFromRequest(req)) : requester);
  let staffMemo: boolean | undefined;
  const isStaff = async () => (staffMemo === undefined ? (staffMemo = await isStaffUser((await who())?.id)) : staffMemo);

  // Zablokovaný kanál se jako živý neukazuje nikomu, shadow-banovaný jen
  // svému majiteli (stejně jako řada "Živě" na hlavní stránce). Moderátoři
  // a správci je vidí s upozorněním, proč je ostatní nevidí.
  let restricted: LiveRestriction | null = null;
  if (banned || shadowBanned) {
    const own = !banned && (await who())?.id === channel;
    if (!own) {
      if (!(await isStaff())) {
        return NextResponse.json({ enabled: true, live: false, profile: publicProfile, stream: null }, { headers: { 'Cache-Control': 'no-store' } });
      }
      restricted = banned ? 'banned' : 'shadow-ban';
    }
  }
  if (!row) return NextResponse.json({ enabled: true, live: false, profile: publicProfile, stream: null }, { headers: { 'Cache-Control': 'no-store' } });
  const stream = await publicLive(row as LiveStreamRow);
  if (stream.live) runInBackground(import('@/lib/nudityScan').then((m) => m.scanLiveStreams()), 'kontrola obsahu přenosů');
  // Statistiky vysílání (lib/liveStats.ts) - na pozadí, nejvýš jednou za minutu; počet diváků
  // pro stránku přenosu jen z paměti (nikdy se na něj nečeká).
  if (stream.live) runInBackground(sampleLiveRow(row as LiveStreamRow), 'statistiky vysílání');
  const viewers = stream.live ? peekLiveViewers((row as LiveStreamRow).cf_input_id) : null;

  // Přenos skrytý automatickou kontrolou obsahu: divákům bez přehrávače
  // ("čeká na kontrolu"), majitel a moderátoři Kine ho vidí i s upozorněním.
  // Skrytí platí jen pro přenos, při kterém vzniklo (lib/nudityRules.ts).
  if (liveHiddenNow(row as any) && stream.live) {
    const own = (await who())?.id === channel;
    const privileged = own || (await isStaff());
    if (!privileged) {
      return NextResponse.json(
        { enabled: true, live: true, held: true, profile: publicProfile, stream: { ...stream, playerUrl: null, hlsUrl: null, inputId: null, videoUid: null, thumbnailUrl: null } },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { enabled: true, live: true, profile: publicProfile, stream, moderation: { hidden: true, restricted, own } },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  // Podpory ve vysílání (tlačítko 💛 u přenosu): jen když kanál běží a umí je přijmout.
  // Podpory ve vysílání jsou placené - dokud placení neběží (lib/payments.ts), nejsou.
  const tips = stream.live && CREATOR_PAYMENTS_ENABLED ? { enabled: await tipsEnabled(channel), feePercent: tipFeePercent(process.env.LIVE_TIP_FEE_PERCENT) } : { enabled: false, feePercent: 0 };
  // Po vysílání: odkaz na záznam (když ho tvůrce zveřejnil) - kdo přišel pozdě, pustí si ho.
  // Mimo vysílání i plán dalšího (odpočet s „Připomenout“), během vysílání a chvíli po něm raid.
  const [lastRecording, schedule, raid] = await Promise.all([
    stream.live ? Promise.resolve(null) : latestRecording(channel),
    stream.live ? Promise.resolve(null as ChannelSchedule | null) : channelSchedule(channel).catch(() => null),
    raidInfo(row as LiveStreamRow).catch(() => null),
  ]);
  // Bez přihlášení je odpověď pro všechny stejná (stránka přenosu se ptá každých 6 s, odznak
  // u kanálu každých 30 s) - pár vteřin ji podrží CDN. Přihlášeným (majitel, tým Kine) vždy čerstvá.
  // Jen dotaz bez přihlášení s "anon=1" v adrese (lib/authHeaders.ts - cacheableUrl) - přihlášený má jinou adresu.
  const anonymous = !req.headers.get('authorization') && req.nextUrl.searchParams.get('anon') === '1';
  return NextResponse.json(
    { enabled: true, live: stream.live, profile: publicProfile, stream, tips, lastRecording, viewers, schedule, raid, ...(restricted ? { moderation: { hidden: false, restricted } } : {}) },
    { headers: anonymous && !restricted ? { 'Cache-Control': 'public, s-maxage=3, stale-while-revalidate=5', Vary: 'Authorization' } : { 'Cache-Control': 'private, no-store' } }
  );
}
