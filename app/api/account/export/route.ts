import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

// Sesbírá všechno, co appka o uživateli ví, a pošle to jako jeden
// stažitelný soubor - právo na "přenositelnost údajů" podle GDPR.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return NextResponse.json({ error: 'Musíš být přihlášený.' }, { status: 401 });
  }

  const { data: userData, error: userError } = await supabaseServer.auth.getUser(token);
  if (userError || !userData.user) {
    return NextResponse.json({ error: 'Musíš být přihlášený.' }, { status: 401 });
  }

  const userId = userData.user.id;

  const [profile, videos, comments, playlists, posts, subscriptions, watchHistory, gameFollows, pushSettings, pushDevices, liveReminders, pollVotes, liveSchedule] = await Promise.all([
    supabaseServer.from('profiles').select('*').eq('id', userId).single(),
    supabaseServer.from('videos').select('*').eq('owner_id', userId),
    supabaseServer.from('comments').select('*').eq('user_id', userId),
    supabaseServer.from('playlists').select('*').eq('owner_id', userId),
    supabaseServer.from('posts').select('*').eq('owner_id', userId),
    supabaseServer.from('subscriptions').select('*').eq('subscriber_id', userId),
    supabaseServer.from('watch_history').select('*').eq('user_id', userId),
    // Sledované hry a push oznámení (supabase-migration-push-hry-naklady.sql; bez ní prázdné).
    supabaseServer.from('game_follows').select('game, created_at').eq('user_id', userId),
    supabaseServer.from('push_settings').select('live, uploads, replies, earnings, updated_at').eq('user_id', userId).maybeSingle(),
    // Zařízení s oznámeními: bez šifrovacích klíčů, adresa jen jako služba (Google, Apple, Mozilla...).
    supabaseServer.from('push_subscriptions').select('endpoint, lang, user_agent, created_at, last_ok_at').eq('user_id', userId),
    // Připomenutí vysílání, hlasy v anketách chatu, vlastní plán vysílání (supabase-migration-zive-raid-plan-ankety.sql).
    supabaseServer.from('live_reminders').select('owner_id, created_at').eq('user_id', userId),
    supabaseServer.from('live_poll_votes').select('poll_id, choice, created_at').eq('user_id', userId),
    supabaseServer.from('live_schedules').select('starts_at, title, game, created_at, updated_at').eq('owner_id', userId).maybeSingle(),
  ]);

  const exportData = {
    exported_at: new Date().toISOString(),
    account_email: userData.user.email,
    profile: profile.data,
    videos: videos.data ?? [],
    comments: comments.data ?? [],
    playlists: playlists.data ?? [],
    posts: posts.data ?? [],
    subscriptions: subscriptions.data ?? [],
    watch_history: watchHistory.data ?? [],
    followed_games: gameFollows.data ?? [],
    push_settings: pushSettings.data ?? null,
    live_reminders: liveReminders.data ?? [],
    live_poll_votes: pollVotes.data ?? [],
    live_schedule: liveSchedule.data ?? null,
    push_devices: (pushDevices.data ?? []).map((d: { endpoint: string; lang: string; user_agent: string | null; created_at: string; last_ok_at: string | null }) => {
      let service = '';
      try {
        service = new URL(d.endpoint).hostname;
      } catch {
        /* nic */
      }
      return { service, lang: d.lang, user_agent: d.user_agent, created_at: d.created_at, last_ok_at: d.last_ok_at };
    }),
  };

  return NextResponse.json(exportData);
}
