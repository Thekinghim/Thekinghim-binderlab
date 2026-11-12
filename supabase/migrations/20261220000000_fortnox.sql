-- =============================================================================
-- Fortnox: bokföringen skickas som verifikat genom Fortnox eget API (docs/decisions.md,
-- ADR 31). Additiv migrering: nya tabeller och funktioner, inget befintligt ändras, så den
-- kan köras medan den gamla koden är live.
--
-- * public.fortnox_connections   En rad per organisation som kopplat Fortnox: läge
--                                (torrkörning tills ägaren slår på), första månaden att
--                                bokföra, verifikationsserie och kontomappning. Skapas och
--                                tas bort bara av servern; ägare och admin ändrar valen.
-- * public.fortnox_sync_state    Senaste körningen (tid, fel). Skrivs bara av servern.
-- * public.fortnox_vouchers      Utkorgen: ett verifikat per rad med en stabil nyckel
--                                (idem_key, unik per organisation) och Fortnox nummer när
--                                det är skickat. Ett skickat verifikat ändras aldrig och
--                                inget raderas; en rättelse är en ny rad som vänder den
--                                gamla (reverses_id).
-- * Åtkomsttoken och refresh-token ligger i Supabase Vault under
--   "{organization_id}/fortnox", aldrig i en tabell. Bara servern (systemrollen) läser och
--   skriver dem (private.fortnox_*_tokens).
-- * private.fortnox_cron_tick: pg_cron en gång per natt → GET /api/cron/fortnox, som
--   private.bokforing_cron_tick.
--
-- Läsrätt: bara ägare och admin som inte har Enkel vy. Läsare, påfyllare, butiksanvändare
-- och den som har Enkel vy ser ingenting.
-- En demoorganisation kan inte kopplas (triggern nedan).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- fortnox_connections
-- -----------------------------------------------------------------------------
create table public.fortnox_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- connected = token finns. needs_reconnect = Fortnox tog inte emot vår refresh-token.
  status text not null default 'connected'
    check (status in ('connected', 'needs_reconnect')),
  -- false = torrkörning: inget skickas, sidan visar vad som skulle skickas.
  live boolean not null default false,
  -- Första månaden som bokförs (månadens första dag). Krävs innan live slås på.
  start_month date check (start_month is null or extract(day from start_month) = 1),
  voucher_series text not null default 'A' check (voucher_series ~ '^[A-Z0-9]{1,6}$'),
  -- {"accounts": {"bank": "1930", ...}, "kinds": {"cogs": false, ...}}; saknat = standard.
  mapping jsonb not null default '{}'::jsonb
    check (jsonb_typeof(mapping) = 'object' and octet_length(mapping::text) <= 20000),
  -- Bolaget i Fortnox som kopplingen gäller (Fortnox databasnummer och namn). Inte hemligt:
  -- visas för ägaren, och hindrar att ett annat bolag kopplas in mot samma utkorg.
  fortnox_tenant text check (fortnox_tenant is null or char_length(fortnox_tenant) between 1 and 40),
  company_name text check (company_name is null or char_length(company_name) <= 120),
  connected_at timestamptz not null default now(),
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  check (not live or start_month is not null)
);

comment on table public.fortnox_connections is
  'Fortnox: kopplingen per organisation (läge, startmånad, serie, kontomappning). Token ligger i Vault.';

create table public.fortnox_sync_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  -- Misslyckade körningar i rad (larm efter tre), och vem som kör just nu (en i taget).
  failures integer not null default 0 check (failures >= 0),
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

comment on table public.fortnox_sync_state is
  'Fortnox: senaste körningen av jobbet (tid och fel i klartext). Skrivs av servern.';

-- -----------------------------------------------------------------------------
-- fortnox_vouchers (utkorgen)
-- -----------------------------------------------------------------------------
create table public.fortnox_vouchers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Stabil nyckel: "{kind}:{källa}:v{version}" eller "...:rev" för en vändning.
  idem_key text not null check (idem_key ~ '^[a-z_]+:[A-Za-z0-9:_-]{1,120}$'),
  kind text not null
    check (kind in ('sales', 'payout', 'store_share', 'settlement_paid', 'cogs', 'fixed_costs')),
  -- Källan: månad ("2026-10") eller radens id (utbetalning, avräkning).
  source_ref text not null check (char_length(source_ref) between 1 and 80),
  version integer not null default 1 check (version >= 1),
  voucher_date date not null,
  description text not null check (char_length(description) between 1 and 200),
  -- [{"account":"1580","amountOre":7624500,"text":"..."}]; positivt = debet. Summan är 0.
  rows jsonb not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) >= 2),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  -- pending = väntar, sending = skickas just nu (eller svaret kom aldrig), sent = bokfört i
  -- Fortnox, blocked = stoppat tills en människa gjort något (block_code säger vad).
  state text not null default 'pending'
    check (state in ('pending', 'sending', 'sent', 'blocked')),
  block_code text check (block_code is null or block_code ~ '^[a-z_]{1,40}$'),
  block_detail text check (block_detail is null or char_length(block_detail) <= 500),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  -- Serien och räkenskapsåret som det senaste försöket gick till: där letas verifikatet
  -- upp om svaret från Fortnox aldrig kom fram.
  attempt_series text check (attempt_series is null or attempt_series ~ '^[A-Z0-9]{1,6}$'),
  attempt_year integer check (attempt_year is null or attempt_year >= 1),
  sent_at timestamptz,
  fortnox_series text check (fortnox_series is null or fortnox_series ~ '^[A-Z0-9]{1,6}$'),
  fortnox_number integer check (fortnox_number is null or fortnox_number >= 1),
  -- Fortnox id för räkenskapsåret (financialyear).
  fortnox_year integer check (fortnox_year is null or fortnox_year >= 1),
  -- En vändning pekar på verifikatet den vänder.
  reverses_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, idem_key),
  foreign key (organization_id, reverses_id)
    references public.fortnox_vouchers (organization_id, id) on delete restrict,
  check ((state = 'sent') = (fortnox_number is not null)),
  check ((state = 'sent') = (sent_at is not null)),
  check ((fortnox_number is null) = (fortnox_series is null)),
  check ((fortnox_number is null) = (fortnox_year is null)),
  check ((state = 'blocked') = (block_code is not null)),
  check (state <> 'sending' or (claimed_at is not null and attempt_series is not null
                                and attempt_year is not null)),
  check (reverses_id is null or reverses_id <> id)
);

-- Samma verifikat i Fortnox kan aldrig stå på två rader, och ett verifikat vänds en gång.
create unique index fortnox_vouchers_number_uq
  on public.fortnox_vouchers (organization_id, fortnox_year, fortnox_series, fortnox_number)
  where fortnox_number is not null;
create unique index fortnox_vouchers_reverses_uq
  on public.fortnox_vouchers (organization_id, reverses_id) where reverses_id is not null;
create index fortnox_vouchers_open_idx
  on public.fortnox_vouchers (organization_id, voucher_date) where state <> 'sent';
create index fortnox_vouchers_source_idx
  on public.fortnox_vouchers (organization_id, kind, source_ref, version);

comment on table public.fortnox_vouchers is
  'Fortnox: utkorgen. Ett verifikat per rad med stabil nyckel och Fortnox nummer när det är skickat.';

alter table public.fortnox_connections alter column organization_id set statistics 0;
alter table public.fortnox_sync_state alter column organization_id set statistics 0;
alter table public.fortnox_vouchers alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create trigger t00_forbid_org_change before update on public.fortnox_connections
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.fortnox_connections
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.fortnox_connections
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.fortnox_connections
  for each row execute function private.audit();

create trigger t00_forbid_org_change before update on public.fortnox_sync_state
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.fortnox_sync_state
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.fortnox_sync_state
  for each row execute function private.stamp_update();

create trigger t00_forbid_org_change before update on public.fortnox_vouchers
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.fortnox_vouchers
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.fortnox_vouchers
  for each row execute function private.stamp_update();

-- En demoorganisation kopplas aldrig, och en ny koppling börjar i torrkörning.
create function private.fortnox_connections_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.organizations o
               where o.id = new.organization_id and o.is_demo) then
      raise exception 'En demoorganisation kan inte kopplas till Fortnox.' using errcode = '42501';
    end if;
    -- En ny koppling börjar alltid i torrkörning.
    new.live := false;
  end if;
  return new;
end
$$;

revoke all on function private.fortnox_connections_guard() from public, anon, authenticated, service_role;

create trigger t30_guard before insert or update on public.fortnox_connections
  for each row execute function private.fortnox_connections_guard();

-- Ett skickat verifikat ändras aldrig. Nyckel, typ och källa ändras aldrig. Inget raderas.
create function private.fortnox_vouchers_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Verifikat i utkorgen raderas inte.' using errcode = '42501';
  end if;
  if (new.idem_key, new.kind, new.source_ref, new.version, new.reverses_id)
     is distinct from (old.idem_key, old.kind, old.source_ref, old.version, old.reverses_id) then
    raise exception 'Verifikatets nyckel och källa ändras inte.' using errcode = '42501';
  end if;
  if old.state = 'sent' and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'Ett skickat verifikat ändras inte. Rätta med ett nytt verifikat.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function private.fortnox_vouchers_guard() from public, anon, authenticated, service_role;

create trigger t30_guard before update or delete on public.fortnox_vouchers
  for each row execute function private.fortnox_vouchers_guard();

-- -----------------------------------------------------------------------------
-- Behörigheter och policyer
-- -----------------------------------------------------------------------------
alter table public.fortnox_connections enable row level security;
alter table public.fortnox_sync_state enable row level security;
alter table public.fortnox_vouchers enable row level security;

revoke all on table public.fortnox_connections from anon, authenticated, service_role;
revoke all on table public.fortnox_sync_state from anon, authenticated, service_role;
revoke all on table public.fortnox_vouchers from anon, authenticated, service_role;

grant select on table public.fortnox_connections to authenticated;
grant update (live, start_month, voucher_series, mapping) on table public.fortnox_connections
  to authenticated;
grant select, insert, update, delete on table public.fortnox_connections to service_role;

grant select on table public.fortnox_sync_state to authenticated;
grant select, insert, update on table public.fortnox_sync_state to service_role;

grant select on table public.fortnox_vouchers to authenticated;
grant select, insert, update on table public.fortnox_vouchers to service_role;

create policy fortnox_connections_select on public.fortnox_connections for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
         and not (organization_id = any (array(select private.orgs_in_simple_view()))));
create policy fortnox_connections_update on public.fortnox_connections for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
         and not (organization_id = any (array(select private.orgs_in_simple_view()))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
         and not (organization_id = any (array(select private.orgs_in_simple_view()))));

create policy fortnox_sync_state_select on public.fortnox_sync_state for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
         and not (organization_id = any (array(select private.orgs_in_simple_view()))));

create policy fortnox_vouchers_select on public.fortnox_vouchers for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
         and not (organization_id = any (array(select private.orgs_in_simple_view()))));

-- Larmen om Fortnox (incident_key 'fortnox:…', skrivs av jobbet) syns bara för dem som får
-- hantera Fortnox. Restriktiv policy: den läggs ovanpå de vanliga läsreglerna för alerts och
-- ändrar ingenting för andra larm.
create policy alerts_fortnox_restrict on public.alerts as restrictive for select to authenticated
  using (
    incident_key is null
    or incident_key not like 'fortnox:%'
    or (organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
        and not (organization_id = any (array(select private.orgs_in_simple_view()))))
  );

-- -----------------------------------------------------------------------------
-- Token i Vault. Bara servern (systemrollen) når funktionerna.
-- -----------------------------------------------------------------------------
create function private.fortnox_read_tokens(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret::jsonb
  from vault.decrypted_secrets s
  where s.name = p_organization_id::text || '/fortnox'
$$;

create function private.fortnox_save_tokens(
  p_organization_id uuid,
  p_access_token text,
  p_refresh_token text,
  p_access_expires_at timestamptz
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := p_organization_id::text || '/fortnox';
  v_secret_id uuid;
  v_value text;
begin
  if coalesce(btrim(p_access_token), '') = '' or coalesce(btrim(p_refresh_token), '') = ''
     or p_access_expires_at is null then
    raise exception 'Fortnox-token saknas.' using errcode = '22023';
  end if;
  if char_length(p_access_token) > 8000 or char_length(p_refresh_token) > 2000 then
    raise exception 'Fortnox-token är för lång.' using errcode = '22023';
  end if;
  v_value := jsonb_build_object(
    'accessToken', p_access_token,
    'refreshToken', p_refresh_token,
    'accessExpiresAt', to_char(p_access_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )::text;
  select s.id into v_secret_id from vault.secrets s where s.name = v_name;
  if v_secret_id is null then
    perform vault.create_secret(v_value, v_name, 'Binderlab: Fortnox-token för en organisation');
  else
    perform vault.update_secret(v_secret_id, v_value);
  end if;
end
$$;

create function private.fortnox_clear_tokens(p_organization_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from vault.secrets s where s.name = p_organization_id::text || '/fortnox'
$$;

revoke all on function private.fortnox_read_tokens(uuid) from public, anon, authenticated, service_role;
revoke all on function private.fortnox_save_tokens(uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.fortnox_clear_tokens(uuid) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Rättelse: ägare eller admin ber om att ett skickat verifikat vänds. Vändningen är en ny
-- rad i utkorgen med samma belopp på motsatt sida; jobbet skickar den. Nästa körning lägger
-- sedan upp en ny version av verifikatet om källan finns kvar.
-- -----------------------------------------------------------------------------
create function public.fortnox_request_reversal(p_organization_id uuid, p_voucher_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.fortnox_vouchers%rowtype;
  v_id uuid;
  v_rows jsonb;
begin
  if not private.has_role(p_organization_id, 'owner'::public.member_role, 'admin'::public.member_role)
     or private.in_simple_view(p_organization_id) then
    raise exception 'Bara ägare och administratörer får rätta verifikat.' using errcode = '42501';
  end if;
  select * into v from public.fortnox_vouchers f
  where f.organization_id = p_organization_id and f.id = p_voucher_id
  for update;
  if not found then
    raise exception 'Verifikatet finns inte.' using errcode = 'P0002';
  end if;
  if v.state <> 'sent' then
    raise exception 'Bara ett skickat verifikat kan vändas.' using errcode = '22023';
  end if;
  if v.reverses_id is not null then
    raise exception 'En vändning vänds inte.' using errcode = '22023';
  end if;
  select r.id into v_id from public.fortnox_vouchers r
  where r.organization_id = p_organization_id and r.reverses_id = v.id;
  if v_id is not null then
    return v_id;
  end if;
  select jsonb_agg(
           jsonb_set(e.value, '{amountOre}', to_jsonb(-((e.value ->> 'amountOre')::bigint)))
           order by e.ordinality)
  into v_rows
  from jsonb_array_elements(v.rows) with ordinality as e(value, ordinality);
  insert into public.fortnox_vouchers
    (organization_id, idem_key, kind, source_ref, version, voucher_date, description, rows,
     fingerprint, reverses_id, created_by)
  values
    (p_organization_id, v.idem_key || ':rev', v.kind, v.source_ref, v.version, v.voucher_date,
     left('Rättelse av ' || v.fortnox_series || ' ' || v.fortnox_number::text || ': ' || v.description, 200),
     v_rows, encode(extensions.digest(v_rows::text, 'sha256'), 'hex'), v.id, auth.uid())
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function public.fortnox_request_reversal(uuid, uuid) from public, anon;
grant execute on function public.fortnox_request_reversal(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- pg_cron → GET /api/cron/fortnox en gång per natt. Inget görs utan adress, hemlighet
-- och pg_net (samma mönster som private.bokforing_cron_tick).
-- -----------------------------------------------------------------------------
create or replace function private.fortnox_cron_tick()
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
    using v_url || '/api/cron/fortnox',
          jsonb_build_object('Authorization', 'Bearer ' || v_secret),
          300000;
  return v_request;
end
$$;

revoke all on function private.fortnox_cron_tick() from public, anon, authenticated, service_role;

-- 03:57 UTC = 04:57/05:57 svensk tid: efter bokföringspaketet (03:37) och nattens Awish-synk.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    begin
      execute $cmd$select cron.schedule('binderlab-fortnox', '57 3 * * *', 'select private.fortnox_cron_tick()')$cmd$;
    exception when others then
      raise warning 'Fortnox-jobbets schema (pg_cron) kunde inte sättas upp: %', sqlerrm;
    end;
  end if;
end
$$;

revoke all on all functions in schema private from public;
