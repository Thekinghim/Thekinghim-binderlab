-- =============================================================================
-- Veckosammanfattning: en notis (push) varje måndag morgon till ägare och admin.
--
-- 1. profiles.weekly_summary (true | false | null): personens egen knapp
--    "Veckosammanfattning". null = inte valt: då följer den "Notiser i mobilen" (på om
--    personen har push bland sina larmkanaler). Personen ändrar sin egen rad
--    (profiles_update, som för språket).
-- 2. public.weekly_summaries: en rad per person och vecka med det som skickades
--    (rubrik, text, adress, siffrorna). unique (organization_id, user_id, week_start) gör
--    att samma vecka aldrig skickas två gånger: jobbet lägger raden först (on conflict do
--    nothing) och skickar bara om raden blev ny. Skrivs bara av servern (systemrollen).
--    Personen läser sina egna rader; ägare och admin ser organisationens.
-- 3. private.vecka_cron_tick: anropas av pg_cron måndagar 05:07, 06:07 och 07:07 UTC och gör GET
--    {binderlab_app_url}/api/cron/vecka med "Authorization: Bearer {binderlab_cron_secret}"
--    via pg_net, som private.kontroll_cron_tick. Routen skickar första tillfället från
--    07:00 i organisationens tidszon (07:07 svensk tid både sommar och vinter). Lokalt och
--    i CI schemaläggs inget.
--
-- Allt är additivt: en ny kolumn, en ny tabell och en ny funktion.
-- =============================================================================

alter table public.profiles
  add column weekly_summary boolean;

comment on column public.profiles.weekly_summary is
  'Veckosammanfattning (push på måndagar): true/false, null = följer Notiser i mobilen.';

grant update (display_name, locale, weekly_summary) on table public.profiles to authenticated;

create table public.weekly_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid references auth.users (id) on delete set null,
  -- Måndagen i veckan som sammanfattas.
  week_start date not null check (extract(isodow from week_start) = 1),
  -- pending = raden är lagd, notisen inte skickad än; sent = minst en telefon fick den;
  -- failed = ingen telefon fick den.
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  locale text not null check (locale in ('sv', 'en')),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) <= 600),
  url text not null check (url ~ '^/[A-Za-z0-9/?=&_-]*$' and char_length(url) <= 200),
  -- Siffrorna bakom texten (pack och vinst i öre för båda veckorna, bästa produkten, Att göra).
  figures jsonb not null default '{}'::jsonb
    check (jsonb_typeof(figures) = 'object' and pg_column_size(figures) <= 8192),
  devices integer not null default 0 check (devices between 0 and 100),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id, week_start)
);

create index weekly_summaries_user_idx
  on public.weekly_summaries (organization_id, user_id, week_start desc);

comment on table public.weekly_summaries is
  'Veckosammanfattning: det som skickades per person och vecka (skrivs av servern). En rad per person och vecka.';

create trigger t00_forbid_org_change before update on public.weekly_summaries
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.weekly_summaries
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.weekly_summaries
  for each row execute function private.stamp_update();

alter table public.weekly_summaries alter column organization_id set statistics 0;

alter table public.weekly_summaries enable row level security;
revoke all on table public.weekly_summaries from anon, authenticated, service_role;
grant select on table public.weekly_summaries to authenticated;
grant select, insert, update on table public.weekly_summaries to service_role;

-- Egna rader; ägare och admin ser organisationens.
create policy weekly_summaries_select on public.weekly_summaries
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      user_id = (select auth.uid())
      and organization_id = any (array(select private.orgs_with_role('viewer')))
    )
  );

-- -----------------------------------------------------------------------------
-- pg_cron → GET /api/cron/vecka måndagar (routen väljer rätt tillfälle).
-- Inget görs utan adress, hemlighet och pg_net.
-- -----------------------------------------------------------------------------
create or replace function private.vecka_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if to_regnamespace('net') is null then
    return null;
  end if;
  select btrim(s.decrypted_secret) into v_url
  from vault.decrypted_secrets s where s.name = 'binderlab_app_url';
  select btrim(s.decrypted_secret) into v_secret
  from vault.decrypted_secrets s where s.name = 'binderlab_cron_secret';
  if v_url is null or v_secret is null or char_length(v_secret) < 16
     or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
    return null;
  end if;
  execute 'select net.http_get(url := $1, headers := $2, timeout_milliseconds := $3)'
    into v_request
    using v_url || '/api/cron/vecka',
          jsonb_build_object('Authorization', 'Bearer ' || v_secret),
          300000;
  return v_request;
end
$$;

revoke all on function private.vecka_cron_tick() from public, anon, authenticated, service_role;

-- Måndagar 05:07, 06:07 och 07:07 UTC: 07:07 svensk tid är 05:07 UTC på sommaren och 06:07 UTC
-- på vintern. Körningen efter den provar igen om ingen telefon fick notisen (aldrig två notiser).
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    begin
      execute $cmd$select cron.schedule('binderlab-vecka', '7 5,6,7 * * 1', 'select private.vecka_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Veckosammanfattningens schema (pg_cron) kunde inte sättas upp: %', sqlerrm;
    end;
  elsif exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    begin
      execute 'create extension if not exists pg_net with schema extensions';
      execute 'create extension if not exists pg_cron with schema pg_catalog';
      execute $cmd$select cron.schedule('binderlab-vecka', '7 5,6,7 * * 1', 'select private.vecka_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Veckosammanfattningens schema (pg_cron/pg_net) kunde inte sättas upp: %', sqlerrm;
    end;
  end if;
end
$$;

revoke all on all functions in schema private from public;
