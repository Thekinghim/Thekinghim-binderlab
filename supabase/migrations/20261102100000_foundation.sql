-- =============================================================================
-- Binderlab, datamodell v2: grund.
-- Tillägg, schemat private, uppräkningstyper och generiska triggerfunktioner.
--
-- Felkoder (SQLSTATE) som databasen själv kastar. Serverkoden mappar dem till
-- svenska meddelanden i gränssnittet.
--   BL001  organization_id får inte ändras
--   BL002  tabellen är append-only (update/delete förbjudet)
--   BL003  ekonomiska data raderas inte (arkivera i stället)
--   BL004  ändringen påverkar en stängd månad
--   BL005  organisationen måste ha minst en ägare
--   BL006  rollhöjning förbi den egna rollen
--   BL007  en importerad order ändras inte
--   BL010..BL014  inbjudan: finns inte / redan använd / utgången / fel e-post / redan medlem
--   BL015  månaden är redan stängd, BL016 månaden är inte stängd
--   BL017  lagerflytt går inte jämnt ut, BL018 ägarandelar summerar inte till 10 000
--   BL019  automatgräns för organisationen nådd
--   42501  behörighet saknas (standardkod)
--   22023  ogiltigt argument (standardkod)
-- =============================================================================

create extension if not exists citext with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Schemat private exponeras inte via API:t. Bara authenticated (och service_role)
-- får använda det, och bara de funktioner som uttryckligen tilldelas.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Inga rättigheter för anon på framtida objekt i public, och inga
-- EXECUTE-rättigheter för PUBLIC på framtida funktioner.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon, public;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from authenticated, service_role;
alter default privileges for role postgres in schema private revoke all on functions from public;

-- -----------------------------------------------------------------------------
-- Uppräkningstyper
-- -----------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'admin', 'refiller', 'viewer');
create type public.organization_plan as enum ('trial', 'standard', 'enterprise');
create type public.commission_base as enum ('net_excl_vat');
create type public.rent_proration as enum ('daily');
create type public.machine_investment_kind as enum ('purchase', 'installation', 'other');
create type public.data_source_provider as enum ('awish_grpc', 'awish_web', 'awish_csv');
create type public.data_source_status as enum ('active', 'paused', 'error');
create type public.import_trigger as enum ('upload', 'schedule', 'webhook');
create type public.import_status as enum ('pending', 'running', 'succeeded', 'failed');
create type public.import_row_status as enum ('new', 'conflict', 'error');
create type public.stock_location_kind as enum ('warehouse', 'machine');
create type public.stock_event_kind as enum (
  'refill', 'count', 'sale', 'waste', 'adjustment', 'transfer_in', 'transfer_out', 'receipt'
);
create type public.purchase_order_status as enum (
  'draft', 'ordered', 'partially_received', 'received', 'cancelled'
);
create type public.target_scope as enum ('organization', 'store', 'machine');
create type public.goal_metric as enum ('revenue', 'profit', 'active_machines');
create type public.baseline_metric as enum (
  'profit_per_machine_month', 'stockout_days_month', 'refill_hours_month', 'admin_hours_month'
);
create type public.baseline_unit as enum ('ore', 'days', 'minutes', 'count');
create type public.report_recipient_kind as enum ('store', 'accountant', 'partner');
create type public.report_kind as enum (
  'store_statement', 'owner_statement', 'accountant_statement', 'profitability'
);
create type public.report_delivery_status as enum ('queued', 'sent', 'delivered', 'failed', 'bounced');
create type public.alert_severity as enum ('info', 'warning', 'critical');
create type public.audit_action as enum ('insert', 'update', 'delete');

-- -----------------------------------------------------------------------------
-- Små hjälpfunktioner
-- -----------------------------------------------------------------------------

-- Giltig IANA-tidszon? Används i check-villkor.
create function private.is_valid_timezone(p_tz text) returns boolean
language sql immutable strict
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz)
$$;

-- Tolkar text som uuid, eller null (används på sökvägar i storage-policyer).
create function private.try_uuid(p_value text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case
    when p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then p_value::uuid
  end
$$;

-- Systemrensning (gallring efter 7 år, rådata efter 24 månader) är det enda
-- tillfälle då rader i skyddade tabeller får raderas. Det kräver att jobbet
-- kör som en systemroll (aldrig anon/authenticated) och sätter
-- binderlab.allow_purge = 'on' lokalt i sin transaktion.
create function private.purge_allowed() returns boolean
language sql stable
set search_path = ''
as $$
  select current_user not in ('anon', 'authenticated')
     and coalesce(current_setting('binderlab.allow_purge', true), '') = 'on'
$$;

-- Är id:t en befintlig användare? (security definer: auth.users är stängd.)
create function private.user_exists(p_user_id uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users u where u.id = p_user_id)
$$;

-- Nycklar vars värde skiljer sig mellan två rader (jsonb).
create function private.changed_keys(p_old jsonb, p_new jsonb) returns text[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array_agg(k order by k), '{}')
  from (
    select key as k from jsonb_each(p_old)
    union
    select key from jsonb_each(p_new)
  ) keys
  where p_old -> k is distinct from p_new -> k
$$;

-- Kolumner som pekar på en aktör (auth.users). Raderas användaren sätts de
-- till null (GDPR) och det är inte en affärsändring.
create function private.actor_columns() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    'created_by', 'performed_by', 'actor_id', 'accepted_by', 'invited_by', 'closed_by',
    'reopened_by', 'generated_by', 'member_user_id', 'acknowledged_by', 'user_id'
  ]
$$;

-- Är uppdateringen bara att aktörskolumner nollas för användare som inte
-- längre finns? (FK on delete set null mot auth.users.)
create function private.is_actor_anonymization(p_old jsonb, p_new jsonb) returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_key text;
  v_changed text[] := private.changed_keys(p_old, p_new);
begin
  if cardinality(v_changed) = 0 then
    return false;
  end if;
  foreach v_key in array v_changed loop
    if v_key = 'updated_at' then
      continue;
    end if;
    if not (v_key = any (private.actor_columns()))
       or jsonb_typeof(p_new -> v_key) <> 'null'
       or private.user_exists((p_old ->> v_key)::uuid) then
      return false;
    end if;
  end loop;
  return true;
end
$$;

-- -----------------------------------------------------------------------------
-- Generiska triggerfunktioner
-- -----------------------------------------------------------------------------

-- organization_id kan aldrig ändras, inte ens av service_role eller postgres.
create function private.forbid_org_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception using
      errcode = 'BL001',
      message = format('organization_id kan inte ändras (%s)', tg_table_name);
  end if;
  return new;
end
$$;

-- created_at sätts av databasen och created_by till den inloggade användaren
-- (behålls som angivet för systemjobb utan användare).
create function private.stamp_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  new.created_at := now();
  if v_uid is not null then
    new.created_by := v_uid;
  end if;
  return new;
end
$$;

-- updated_at sätts vid varje ändring; created_at/created_by kan inte ändras
-- (utom att created_by nollas när användaren raderas).
create function private.stamp_update() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  if new.created_by is distinct from old.created_by
     and not (new.created_by is null and not private.user_exists(old.created_by)) then
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- Ekonomiska data raderas inte (bokföringslagen, 7 år). Arkivera i stället.
create function private.forbid_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.purge_allowed() then
    return old;
  end if;
  raise exception using
    errcode = 'BL003',
    message = format('Rader i %s raderas inte. Arkivera i stället.', tg_table_name);
end
$$;

-- Append-only: update och delete är förbjudna för alla roller.
-- Två kontrollerade undantag, som bara kan inträffa i systemkontext
-- (inuti en annan trigger eller FK-åtgärd, aldrig direkt från en klient):
--   1. Aktörskolumner nollas när användaren raderas (FK on delete set null).
--   2. stock_events: en försäljningshändelse (kind = 'sale') följer med när
--      orderns titel ändras vid sammanslagning. Bara title_id får ändras, och
--      bara till det värde ordern faktiskt har. Ändringen loggas i audit_log.
-- Radering är bara tillåten för systemets gallringsjobb (private.purge_allowed).
create function private.forbid_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_order_title uuid;
  v_system boolean := current_user not in ('anon', 'authenticated', 'service_role')
                      and pg_trigger_depth() > 1;
begin
  if tg_op = 'DELETE' then
    if private.purge_allowed() then
      return old;
    end if;
    raise exception using
      errcode = 'BL002',
      message = format('%s är append-only: rader kan inte raderas', tg_table_name);
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  if v_system and private.is_actor_anonymization(v_old, v_new) then
    return new;
  end if;

  if v_system
     and tg_table_name = 'stock_events'
     and v_old ->> 'kind' = 'sale'
     and private.changed_keys(v_old, v_new) = array['title_id'] then
    select o.title_id into v_order_title
    from public.orders o
    where o.organization_id = (v_old ->> 'organization_id')::uuid
      and o.id = (v_old ->> 'order_id')::uuid;
    if v_order_title is not null and v_order_title = (v_new ->> 'title_id')::uuid then
      return new;
    end if;
  end if;

  raise exception using
    errcode = 'BL002',
    message = format('%s är append-only: rader kan inte ändras', tg_table_name),
    hint = 'Rätta med en ny rad.';
end
$$;

create function private.forbid_truncate() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'BL002',
    message = format('%s kan inte tömmas (truncate)', tg_table_name);
end
$$;

revoke all on all functions in schema private from public;
