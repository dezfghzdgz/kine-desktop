-- Spusť v Supabase dashboardu -> SQL Editor -> New Query
--
-- PODPORY VE VYSÍLÁNÍ + AUTOMATICKÁ KONTROLA NAHOTY (říjen 2026)
--
--   1. Podpory (donaty) ve vysílání: divák pošle tvůrci částku přes Stripe
--      a vzkaz se ukáže zvýrazněný v chatu (a jde přečíst nahlas).
--   2. Automatická kontrola nahoty a porna u videí a živých přenosů:
--      co model najde, se skryje nebo pošle moderátorům ke kontrole;
--      umělecká díla posoudí člověk.
--
-- Dá se pustit opakovaně. Web funguje i bez ní - jen bez těchhle novinek.
-- Na konci vypíše tabulku s tím, co udělal.

drop table if exists _migrace_zprava;
create temp table _migrace_zprava (poradi serial, co text, vysledek text);


-- =====================================================================
-- 1. Podpory ve vysílání
-- =====================================================================
-- Tvůrce může podpory vypnout (ve studiu); bez propojeného Stripe je
-- stejně dostávat nejde.
alter table profiles add column if not exists live_tips_enabled boolean not null default true;

create table if not exists live_tips (
  id bigint generated always as identity primary key,
  channel_id uuid not null references profiles(id) on delete cascade,
  user_id uuid references profiles(id) on delete set null,
  amount_cents int not null check (amount_cents > 0),
  currency text not null check (currency in ('czk', 'eur')),
  fee_cents int not null default 0 check (fee_cents >= 0),
  message text not null default '' check (char_length(message) <= 200),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded')),
  stripe_session_id text unique,
  stripe_payment_intent text,
  chat_message_id bigint,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists live_tips_channel_idx on live_tips (channel_id, created_at desc);
create index if not exists live_tips_user_idx on live_tips (user_id, created_at desc);
alter table live_tips enable row level security;
-- Vidí je jen tvůrce, který je dostal, a ten, kdo je poslal. Zápis jen server.
do $$ begin
  create policy "Podpory vidí příjemce a odesílatel" on live_tips for select
    using (auth.uid() = channel_id or auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $mig$
begin
  if to_regclass('public.live_chat_messages') is null then
    insert into _migrace_zprava (co, vysledek) values ('podpory v chatu', 'chat neexistuje (spust supabase-migration-zive-vysilani.sql), preskoceno');
    return;
  end if;
  -- Zpráva v chatu: obyčejná, nebo podpora (s částkou). Zapisuje jen server.
  execute 'alter table live_chat_messages add column if not exists kind text not null default ''chat''';
  execute 'alter table live_chat_messages drop constraint if exists live_chat_messages_kind_check';
  -- Druhy zpráv: obyčejná, podpora, raid a anketa (supabase-migration-zive-raid-plan-ankety.sql) - opakované spuštění je nesmí zúžit.
  execute 'alter table live_chat_messages add constraint live_chat_messages_kind_check check (kind in (''chat'', ''tip'', ''raid'', ''poll''))';
  execute 'alter table live_chat_messages add column if not exists tip_amount_cents int';
  execute 'alter table live_chat_messages add column if not exists tip_currency text';
  execute 'alter table live_chat_messages drop constraint if exists live_chat_messages_tip_currency_check';
  execute 'alter table live_chat_messages add constraint live_chat_messages_tip_currency_check check (tip_currency is null or tip_currency in (''czk'', ''eur''))';
  insert into _migrace_zprava (co, vysledek) values ('podpory ve vysilani (live_tips, podpory v chatu)', 'hotovo');
end $mig$;


-- =====================================================================
-- 2. Automatická kontrola nahoty a porna
-- =====================================================================
do $mig$
begin
  if to_regclass('public.videos') is null then
    insert into _migrace_zprava (co, vysledek) values ('kontrola videi', 'tabulka videos neexistuje, preskoceno');
    return;
  end if;
  -- Kdy video prošlo kontrolou (null = ještě ne - zkontroluje se postupně).
  execute 'alter table videos add column if not exists moderation_checked_at timestamptz';
  -- porn / nudity - co model našel (jen když něco našel).
  execute 'alter table videos add column if not exists moderation_reason text';
  -- hidden = skryté, čeká na moderátora; removed = moderátor nechal skryté.
  execute 'alter table videos add column if not exists moderation_hold text';
  execute 'alter table videos drop constraint if exists videos_moderation_hold_check';
  execute 'alter table videos add constraint videos_moderation_hold_check check (moderation_hold is null or moderation_hold in (''hidden'', ''removed''))';
  -- Viditelnost před skrytím - po schválení se vrátí.
  execute 'alter table videos add column if not exists moderation_prev_visibility text';
  -- Autor označil video jako umělecké (akt, malba...): nahota ho neskryje, jen pošle ke kontrole.
  execute 'alter table videos add column if not exists artistic boolean not null default false';
  execute 'create index if not exists videos_unchecked_idx on videos (created_at desc) where moderation_checked_at is null';
  insert into _migrace_zprava (co, vysledek) values ('kontrola videi (sloupce moderation_*, artistic)', 'hotovo');
end $mig$;

-- Skryté video si autor nemůže sám zveřejnit a výsledek kontroly nezmění
-- (to smí jen server - moderátor přes /reports). Nový vlastní náhled =
-- znovu zkontrolovat.
create or replace function protect_video_moderation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and coalesce(auth.role(), '') <> 'service_role' then
    if tg_op = 'INSERT' then
      new.moderation_checked_at := null;
      new.moderation_reason := null;
      new.moderation_hold := null;
      new.moderation_prev_visibility := null;
    else
      new.moderation_checked_at := old.moderation_checked_at;
      new.moderation_reason := old.moderation_reason;
      new.moderation_hold := old.moderation_hold;
      new.moderation_prev_visibility := old.moderation_prev_visibility;
      if old.moderation_hold is not null then
        new.visibility := old.visibility;
      end if;
      if new.thumbnail_url is distinct from old.thumbnail_url then
        new.moderation_checked_at := null;
      end if;
    end if;
  end if;
  return new;
end;
$$;

do $mig$
begin
  if to_regclass('public.videos') is null then return; end if;
  execute 'drop trigger if exists trg_protect_video_moderation on videos';
  execute 'create trigger trg_protect_video_moderation before insert or update on videos
           for each row execute function protect_video_moderation()';
  insert into _migrace_zprava (co, vysledek) values ('ochrana vysledku kontroly (jen server)', 'zapnuto');
end $mig$;

do $mig$
begin
  if to_regclass('public.live_streams') is null then
    insert into _migrace_zprava (co, vysledek) values ('kontrola prenosu', 'tabulka live_streams neexistuje, preskoceno');
    return;
  end if;
  execute 'alter table live_streams add column if not exists moderation_checked_at timestamptz';
  execute 'alter table live_streams add column if not exists moderation_strikes jsonb not null default ''[]''::jsonb';
  execute 'alter table live_streams add column if not exists moderation_hidden_at timestamptz';
  execute 'alter table live_streams add column if not exists moderation_cleared_uid text';
  insert into _migrace_zprava (co, vysledek) values ('kontrola zivych prenosu', 'hotovo');
end $mig$;

-- Fronta pro moderátory (/reports). Čte a zapisuje jen server.
create table if not exists content_flags (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('video', 'live')),
  video_id uuid references videos(id) on delete cascade,
  channel_id uuid not null references profiles(id) on delete cascade,
  live_video_uid text,
  verdict text not null check (verdict in ('hidden', 'review')),
  reason text not null default 'nudity',
  scores jsonb not null default '[]'::jsonb,
  artistic boolean not null default false,
  status text not null default 'open' check (status in ('open', 'approved', 'removed')),
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists content_flags_open_idx on content_flags (status, created_at desc);
create index if not exists content_flags_video_idx on content_flags (video_id) where video_id is not null;
alter table content_flags enable row level security;
insert into _migrace_zprava (co, vysledek) values ('fronta kontroly obsahu (content_flags)', 'hotovo');


-- Ať Supabase nové sloupce a tabulky hned uvidí.
notify pgrst, 'reload schema';

select co as "co se delo", vysledek as "vysledek" from _migrace_zprava order by poradi;
