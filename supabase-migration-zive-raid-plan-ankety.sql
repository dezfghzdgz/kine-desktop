-- =====================================================================
-- Kine 0137: klip z živého vysílání, raid, plánované vysílání
--            s připomenutím, ankety v chatu
--
-- Spusť CELÉ v Supabase -> SQL Editor. Jde pouštět opakovaně (nic nemaže).
-- Na konci tabulka: chat / raid / plan / ankety = true.
--
-- Klipy z živého vysílání nepotřebují nic nového (jsou to obyčejná videa
-- jako klipy z videí - sloupec clipped_by z supabase-migration-klipy.sql).
-- Všechny nové tabulky čte a zapisuje jen server (API Kine) - prohlížeč
-- k nim přímo nesmí (zapnuté RLS bez politik + odebraná práva).
-- =====================================================================

-- ---------------------------------------------------------------------
-- A) Chat: nové druhy zpráv - raid (přišli diváci od jiného streamera)
--    a anketa. Zapisuje je jen server.
-- ---------------------------------------------------------------------
do $mig$ begin
  if to_regclass('public.live_chat_messages') is null then
    raise notice 'A) chybí live_chat_messages (spusť supabase-migration-zive-vysilani.sql) - přeskočeno.';
    return;
  end if;
  execute 'alter table live_chat_messages add column if not exists kind text not null default ''chat''';
  execute 'alter table live_chat_messages drop constraint if exists live_chat_messages_kind_check';
  execute 'alter table live_chat_messages add constraint live_chat_messages_kind_check check (kind in (''chat'', ''tip'', ''raid'', ''poll''))';
  -- Údaje k raidu / anketě (počet diváků, id ankety). Sloupec zakládá i supabase-migration-chat-emoty.sql.
  execute 'alter table live_chat_messages add column if not exists meta jsonb';
end $mig$;

-- ---------------------------------------------------------------------
-- B) Raid: na konci vysílání streamer pošle své diváky k jinému, který
--    právě vysílá. Stránka přenosu je za pár vteřin přesune sama.
-- ---------------------------------------------------------------------
create table if not exists live_raids (
  id bigint generated always as identity primary key,
  from_owner uuid not null references profiles(id) on delete cascade,
  to_owner uuid not null references profiles(id) on delete cascade,
  viewers int check (viewers is null or viewers >= 0),
  created_at timestamptz not null default now(),
  constraint live_raids_not_self check (from_owner <> to_owner)
);
create index if not exists live_raids_from_idx on live_raids (from_owner, created_at desc);
create index if not exists live_raids_to_idx on live_raids (to_owner, created_at desc);
alter table live_raids enable row level security;
revoke all on live_raids from anon, authenticated;

-- Kam právě vede raid kanálu (a kdy začal) - čte jen server (live_streams nemá politiky).
do $mig$ begin
  if to_regclass('public.live_streams') is null then
    raise notice 'B) chybí live_streams (živé vysílání ještě není v databázi) - raid přeskočen.';
    return;
  end if;
  execute 'alter table live_streams add column if not exists raid_to uuid references profiles(id) on delete set null';
  execute 'alter table live_streams add column if not exists raid_at timestamptz';
end $mig$;

-- ---------------------------------------------------------------------
-- C) Plánované vysílání: kdy kanál začne (odpočet na kanálu a u přenosu)
--    a kdo chce připomenout - dostane oznámení (i push), až začne.
-- ---------------------------------------------------------------------
create table if not exists live_schedules (
  owner_id uuid primary key references profiles(id) on delete cascade,
  starts_at timestamptz not null,
  title text not null default '' check (char_length(title) <= 100),
  game text check (game is null or game ~ '^[a-z0-9-]{1,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists live_schedules_starts_idx on live_schedules (starts_at);
alter table live_schedules enable row level security;
revoke all on live_schedules from anon, authenticated;

create table if not exists live_reminders (
  owner_id uuid not null references profiles(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, user_id),
  constraint live_reminders_not_self check (owner_id <> user_id)
);
create index if not exists live_reminders_user_idx on live_reminders (user_id, created_at desc);
alter table live_reminders enable row level security;
revoke all on live_reminders from anon, authenticated;

-- ---------------------------------------------------------------------
-- D) Ankety v chatu: streamer (nebo moderátor chatu) se zeptá, diváci
--    hlasují - jeden hlas na účet, výsledky živě.
-- ---------------------------------------------------------------------
create table if not exists live_polls (
  id uuid primary key default gen_random_uuid(),
  room text not null check (char_length(room) <= 80),
  created_by uuid references profiles(id) on delete set null,
  question text not null check (char_length(question) between 1 and 120),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 4),
  created_at timestamptz not null default now(),
  ends_at timestamptz not null,
  closed_at timestamptz
);
create index if not exists live_polls_room_idx on live_polls (room, created_at desc);
alter table live_polls enable row level security;
revoke all on live_polls from anon, authenticated;

create table if not exists live_poll_votes (
  poll_id uuid not null references live_polls(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  choice smallint not null check (choice between 0 and 3),
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);
alter table live_poll_votes enable row level security;
revoke all on live_poll_votes from anon, authenticated;

-- Kolik hlasů má která možnost (jen server - kdo jak hlasoval, se nikde neukazuje).
create or replace function live_poll_counts(p_poll uuid)
returns table (choice smallint, votes bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $f$
  select v.choice, count(*)::bigint from live_poll_votes v where v.poll_id = p_poll group by v.choice
$f$;
revoke execute on function live_poll_counts(uuid) from public, anon, authenticated;
grant execute on function live_poll_counts(uuid) to service_role;

-- Server (service_role) smí všechno - Supabase mu práva dává sám, tady pro jistotu.
grant select, insert, update, delete on live_raids, live_schedules, live_reminders, live_polls, live_poll_votes to service_role;

notify pgrst, 'reload schema';

-- Kontrola (true = hotovo).
select
  exists (
    select 1 from pg_constraint
     where conname = 'live_chat_messages_kind_check'
       and pg_get_constraintdef(oid) like '%raid%'
  ) as chat,
  to_regclass('public.live_raids') is not null
    and exists (select 1 from information_schema.columns where table_name = 'live_streams' and column_name = 'raid_to') as raid,
  to_regclass('public.live_schedules') is not null and to_regclass('public.live_reminders') is not null as plan,
  to_regclass('public.live_polls') is not null and to_regprocedure('public.live_poll_counts(uuid)') is not null as ankety;
