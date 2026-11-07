-- =============================================================================
-- Daglig kontroll: Binderlab kontrollerar sina egna siffror varje morgon.
--
-- 1. public.self_check_runs: en rad per körning och organisation med resultatet för
--    varje kontroll (samma vinst överallt, Awish = appen, påfyllningar nådde Awish,
--    synk färsk, avräkningar, datahygien). Skrivs bara av servern (systemrollen), aldrig
--    av klientroller. Append-only. Ägare och admin läser (Inställningar → Kontroll och
--    raden på Hem). created_by = den som tryckte "Kör kontrollen nu" (null = schemalagd).
-- 2. Larmtypen 'self_check' (familjen system, src/server/self-check): ett larm per
--    kontroll som inte går igenom, stängs när kontrollen går igenom igen. alerts.kind har
--    bara ett formatvillkor; private.alert_kinds_valid tar med typen så att den går att
--    välja under Notiser (åtta typer).
-- 3. private.kontroll_cron_tick: anropas av pg_cron 03:37 och 04:37 UTC och gör GET
--    {binderlab_app_url}/api/cron/kontroll med "Authorization: Bearer
--    {binderlab_cron_secret}" via pg_net, som private.bokforing_cron_tick. Routen kör
--    varje organisation en gång per dag, första tillfället efter 05:00 i organisationens
--    tidszon (05:37 svensk tid både sommar och vinter). Lokalt och i CI schemaläggs inget.
--
-- Kontrollen läser bara. Allt är additivt: en ny tabell och två nya funktioner, en
-- ersatt valideringsfunktion.
-- =============================================================================

create table public.self_check_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  ran_at timestamptz not null default now(),
  trigger text not null check (trigger in ('schedule', 'manual')),
  -- ok = allt gick igenom, warning = bara varningar, failed = minst ett fel,
  -- error = kontrollen kunde inte köras.
  status text not null check (status in ('ok', 'warning', 'failed', 'error')),
  failed integer not null default 0 check (failed between 0 and 50),
  warnings integer not null default 0 check (warnings between 0 and 50),
  duration_ms integer not null default 0 check (duration_ms between 0 and 3600000),
  checks jsonb not null default '[]'::jsonb
    check (jsonb_typeof(checks) = 'array' and jsonb_array_length(checks) <= 20
           and pg_column_size(checks) <= 262144),
  error text check (error is null or char_length(error) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id)
);

create index self_check_runs_org_time_idx
  on public.self_check_runs (organization_id, ran_at desc);

comment on table public.self_check_runs is
  'Daglig kontroll: resultatet per körning (skrivs av servern, append-only). Ägare och admin läser.';

create trigger t00_forbid_org_change before update on public.self_check_runs
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.self_check_runs
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.self_check_runs
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.self_check_runs
  for each row execute function private.stamp_insert();

alter table public.self_check_runs alter column organization_id set statistics 0;

alter table public.self_check_runs enable row level security;
revoke all on table public.self_check_runs from anon, authenticated, service_role;
grant select on table public.self_check_runs to authenticated;
-- Update ger servicerollen bara triggerns fel (append-only); samma rättigheter som övriga.
grant select, insert, update on table public.self_check_runs to service_role;

create policy self_check_runs_select on public.self_check_runs
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Larmtypen 'self_check' går att välja under Notiser.
-- -----------------------------------------------------------------------------
create or replace function private.alert_kinds_valid(p_kinds text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_kinds is null or (
    cardinality(p_kinds) between 1 and 8
    and p_kinds <@ array['machine_suspected_fault', 'machine_fault', 'machine_offline',
                         'low_stock', 'import_failed', 'day_anomaly',
                         'machine_discovered', 'self_check']::text[]
  )
$$;

revoke all on function private.alert_kinds_valid(text[]) from public, anon;
grant execute on function private.alert_kinds_valid(text[]) to authenticated;

-- -----------------------------------------------------------------------------
-- pg_cron → GET /api/cron/kontroll två gånger om dagen (routen väljer rätt tillfälle).
-- Inget görs utan adress, hemlighet och pg_net.
-- -----------------------------------------------------------------------------
create or replace function private.kontroll_cron_tick()
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
    using v_url || '/api/cron/kontroll',
          jsonb_build_object('Authorization', 'Bearer ' || v_secret),
          300000;
  return v_request;
end
$$;

revoke all on function private.kontroll_cron_tick() from public, anon, authenticated, service_role;

-- 03:37 och 04:37 UTC: en av dem är 05:37 svensk tid (sommartid respektive vintertid).
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    begin
      execute $cmd$select cron.schedule('binderlab-kontroll', '37 3,4 * * *', 'select private.kontroll_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Kontrollens schema (pg_cron) kunde inte sättas upp: %', sqlerrm;
    end;
  elsif exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    begin
      execute 'create extension if not exists pg_net with schema extensions';
      execute 'create extension if not exists pg_cron with schema pg_catalog';
      execute $cmd$select cron.schedule('binderlab-kontroll', '37 3,4 * * *', 'select private.kontroll_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Kontrollens schema (pg_cron/pg_net) kunde inte sättas upp: %', sqlerrm;
    end;
  end if;
end
$$;

revoke all on all functions in schema private from public;
