-- =============================================================================
-- AI-rådgivaren: dagliga förslag (ai_suggestions) och körningar med tokenåtgång (ai_runs).
--
-- En gång om dagen bygger servern ett kompakt underlag per organisation (försäljning,
-- marginaler, lager, prisändringar, butiksandel, avvikelser) och ber Claude om högst
-- fem förslag. Förslag vars tal inte finns i underlaget kastas (src/server/assistant/
-- advisor). Varje körning sparas i ai_runs med tokens och kostnad; månadens summa
-- jämförs med AI_MONTHLY_BUDGET_SEK innan nästa anrop.
--
-- Behörighet:
--   * Ägare och admin läser båda tabellerna. Läsare och påfyllare ser dem inte
--     (förslagen innehåller belopp och marginaler).
--   * Bara servern (systemrollen) skriver körningar och förslag.
--   * Ägare och admin får bara ändra status (new → done/dismissed och tillbaka). Vem
--     och när sätts av databasen.
--
-- Schemat: private.ai_cron_tick anropas av pg_cron en gång om dagen och gör
-- GET {binderlab_app_url}/api/cron/ai med "Authorization: Bearer {binderlab_cron_secret}"
-- via pg_net, som private.awish_cron_tick (20261103090000_awish_api.sql). Lokalt och
-- i CI finns inte pg_cron/pg_net; då schemaläggs inget.
-- =============================================================================

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- cron: dagliga körningen. manual: knappen "Generera nya förslag".
  trigger text not null check (trigger in ('cron', 'manual')),
  -- running: pågår. ok: förslag sparade. empty: inga förslag klarade kontrollen.
  -- budget: månadens tak nått, inget anrop. error: fel från API:t eller i svaret.
  status text not null default 'running'
    check (status in ('running', 'ok', 'empty', 'budget', 'error')),
  model text not null check (char_length(model) between 1 and 100),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  -- Kostnad i öre (SEK), räknad med listpriset och AI_USD_SEK.
  cost_ore integer not null default 0 check (cost_ore >= 0),
  accepted integer not null default 0 check (accepted between 0 and 5),
  -- [{ title, reason }] för förslag som kastades (tal utanför underlaget m.m.).
  rejected jsonb not null default '[]'::jsonb check (jsonb_typeof(rejected) = 'array'),
  error text check (error is null or char_length(error) <= 2000),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create index ai_runs_org_created_idx on public.ai_runs (organization_id, created_at desc);
create index ai_runs_created_idx on public.ai_runs (created_at);

create table public.ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  run_id uuid not null,
  rank smallint not null check (rank between 1 and 5),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  why text not null check (char_length(btrim(why)) between 1 and 400),
  action text not null check (char_length(btrim(action)) between 1 and 300),
  effect_sek_month integer not null check (effect_sek_month between 0 and 10000000),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  status text not null default 'new' check (status in ('new', 'done', 'dismissed')),
  status_by uuid references auth.users (id) on delete set null,
  status_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, run_id, rank),
  foreign key (organization_id, run_id)
    references public.ai_runs (organization_id, id) on delete restrict
);

create index ai_suggestions_org_status_idx
  on public.ai_suggestions (organization_id, status, created_at desc);

alter table public.ai_runs alter column organization_id set statistics 0;
alter table public.ai_suggestions alter column organization_id set statistics 0;

-- Vem och när för statusändringar sätts av databasen.
create function private.ai_suggestions_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.status_by := auth.uid();
    new.status_at := case when new.status = 'new' then null else now() end;
    if new.status = 'new' then
      new.status_by := null;
    end if;
  else
    new.status_by := old.status_by;
    new.status_at := old.status_at;
  end if;
  return new;
end
$$;

revoke all on function private.ai_suggestions_stamp() from public, anon, authenticated, service_role;

create trigger t00_forbid_org_change before update on public.ai_runs
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.ai_runs
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.ai_runs
  for each row execute function private.stamp_update();

create trigger t00_forbid_org_change before update on public.ai_suggestions
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.ai_suggestions
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.ai_suggestions
  for each row execute function private.stamp_update();
create trigger t30_status_stamp before update on public.ai_suggestions
  for each row execute function private.ai_suggestions_stamp();
create trigger t90_audit after insert or update or delete on public.ai_suggestions
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------
alter table public.ai_runs enable row level security;
alter table public.ai_suggestions enable row level security;

revoke all on table public.ai_runs from anon, authenticated, service_role;
revoke all on table public.ai_suggestions from anon, authenticated, service_role;

grant select on table public.ai_runs to authenticated;
grant select on table public.ai_suggestions to authenticated;
grant update (status) on table public.ai_suggestions to authenticated;
-- Servernyckeln (service_role) som övriga tabeller; appen skriver via databasägaren.
grant select, insert, update on table public.ai_runs to service_role;
grant select, insert, update on table public.ai_suggestions to service_role;

create policy ai_runs_select on public.ai_runs for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

create policy ai_suggestions_select on public.ai_suggestions for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy ai_suggestions_update on public.ai_suggestions for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- pg_cron → GET /api/cron/ai en gång om dagen. Inget görs utan adress, hemlighet och pg_net.
-- -----------------------------------------------------------------------------
create or replace function private.ai_cron_tick()
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
    using v_url || '/api/cron/ai',
          jsonb_build_object('Authorization', 'Bearer ' || v_secret),
          300000;
  return v_request;
end
$$;

revoke all on function private.ai_cron_tick() from public, anon, authenticated, service_role;

-- 04:43 UTC = 05:43/06:43 svensk tid, efter nattens Awish-synk.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    begin
      execute $cmd$select cron.schedule('binderlab-ai-advisor', '43 4 * * *', 'select private.ai_cron_tick()')$cmd$;
    exception when others then
      raise warning 'AI-rådgivarens schema (pg_cron) kunde inte sättas upp: %', sqlerrm;
    end;
  elsif exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    begin
      execute 'create extension if not exists pg_net with schema extensions';
      execute 'create extension if not exists pg_cron with schema pg_catalog';
      execute $cmd$select cron.schedule('binderlab-ai-advisor', '43 4 * * *', 'select private.ai_cron_tick()')$cmd$;
    exception when others then
      raise warning 'AI-rådgivarens schema (pg_cron/pg_net) kunde inte sättas upp: %', sqlerrm;
    end;
  end if;
end
$$;
