-- =============================================================================
-- Awish styrning: de nya anropen i Awishs gRPC-API v1.2.41 (signerade skrivningar,
-- Version, starta om, strömschema, mata ut, fack, varor, kategorier, medlemmar).
--
-- 1. public.awish_api_state: en rad per Awish API-källa. Senaste Version-svaret (och
--    förra, så att ett byte larmar och kan kvitteras), vilken anslutning som fungerar
--    (TLS eller okrypterad reserv), signeringens läge och status, och om påfyllning och
--    varor skickas via webbpanelen eller API:t. Bara servern skriver; ägare och admin läser.
-- 2. public.awish_actions: granskningsloggen. En rad per skrivning till Awish via API:t:
--    vem, vad, när, begäran (utan sign, timestamp och personuppgifter), Awishs svar och
--    utfallet (pending → ok/failed/unknown, eller blocked utan anrop). unique
--    (organization_id, idempotency_key) gör att samma bekräftelse aldrig skickas två gånger.
--    En demo får bara spara rader med status 'blocked' (demo anropar aldrig Awish).
--    Rader tas aldrig bort; bara utfallet fylls i, en gång.
-- 3. public.machine_power_schedules: automatens strömschema som det skickades till Awish
--    (veckodagar Mån..Sön som "1111100", på/av HH:MM). Läses av ägare, admin och läsare.
-- 4. pg_cron-jobbet binderlab-awish-version ('41 * * * *') → GET /api/cron/awish-version
--    (Version-kontrollen). Bara där pg_cron och pg_net finns, som de andra jobben.
--
-- Allt är additivt: tre nya tabeller, två triggerfunktioner och en tick-funktion.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. awish_api_state
-- -----------------------------------------------------------------------------
create table public.awish_api_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid not null,
  version text check (version is null or char_length(version) between 1 and 40),
  version_seen_at timestamptz,
  previous_version text check (previous_version is null or char_length(previous_version) between 1 and 40),
  version_changed_at timestamptz,
  version_acknowledged_at timestamptz,
  version_acknowledged_by uuid references auth.users (id) on delete set null,
  endpoint text check (endpoint is null or endpoint in ('tls', 'plain')),
  endpoint_checked_at timestamptz,
  endpoint_error text check (endpoint_error is null or char_length(endpoint_error) <= 300),
  sign_mode text check (
    sign_mode is null or sign_mode in ('present_sorted', 'full_sorted', 'present_proto_order')
  ),
  sign_status text not null default 'unverified'
    check (sign_status in ('unverified', 'ok', 'failed')),
  sign_checked_at timestamptz,
  sign_error text check (sign_error is null or char_length(sign_error) <= 300),
  slot_writes_via text not null default 'web'
    check (slot_writes_via in ('web', 'api', 'api_then_web')),
  goods_writes_via text not null default 'web'
    check (goods_writes_via in ('web', 'api', 'api_then_web')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- En rad per källa. Källan hör alltid till organisationen (FK:n nedan), så paret är
  -- lika unikt som källan ensam, och FK:n prövas före unikheten vid ett korsbyte.
  unique (organization_id, data_source_id),
  foreign key (organization_id, data_source_id)
    references public.data_sources (organization_id, id) on delete restrict
);

comment on table public.awish_api_state is
  'Awishs gRPC-API per källa: senaste Version, anslutning (TLS/okrypterad), signeringens läge och om påfyllning/varor går via webbpanelen eller API:t. Skrivs bara av servern.';

create trigger t00_forbid_org_change before update on public.awish_api_state
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.awish_api_state
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.awish_api_state
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.awish_api_state
  for each row execute function private.audit();

alter table public.awish_api_state alter column organization_id set statistics 0;

alter table public.awish_api_state enable row level security;
revoke all on table public.awish_api_state from anon, authenticated, service_role;
grant select on table public.awish_api_state to authenticated;
grant select, insert, update on table public.awish_api_state to service_role;

create policy awish_api_state_select on public.awish_api_state
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 2. awish_actions (granskningsloggen)
-- -----------------------------------------------------------------------------
create table public.awish_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  actor_id uuid references auth.users (id) on delete set null,
  actor_role text check (actor_role is null or char_length(actor_role) <= 40),
  kind text not null check (kind in (
    'reboot', 'shutdown', 'power_schedule_set', 'power_schedule_clear', 'shipment',
    'machine_config', 'slot_update', 'replenish', 'refill_push_api', 'good_create',
    'good_update', 'good_delete', 'category_create', 'category_update', 'category_delete',
    'products_batch', 'member_create', 'member_update', 'member_delete', 'merchant_update',
    'banner_create', 'banner_update', 'banner_delete', 'pickup_code_create', 'sign_probe'
  )),
  machine_id uuid,
  awish_machine_id text check (awish_machine_id is null or awish_machine_id ~ '^[0-9]{1,30}$'),
  target_id text check (target_id is null or char_length(target_id) <= 100),
  request jsonb not null default '{}'::jsonb
    check (jsonb_typeof(request) = 'object' and pg_column_size(request) <= 20000),
  reason text check (reason is null or char_length(reason) <= 500),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 100),
  status text not null default 'pending'
    check (status in ('pending', 'ok', 'failed', 'unknown', 'blocked')),
  awish_code integer,
  awish_message text check (awish_message is null or char_length(awish_message) <= 300),
  error_kind text check (error_kind is null or char_length(error_kind) <= 40),
  request_id text check (request_id is null or char_length(request_id) <= 200),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict
);

comment on table public.awish_actions is
  'Granskningslogg: varje skrivning till Awish via API:t (vem, vad, när, Awishs svar). Begäran utan sign, timestamp och personuppgifter. Skrivs bara av servern; rader tas aldrig bort.';

create index awish_actions_kind_idx
  on public.awish_actions (organization_id, kind, created_at desc);
create index awish_actions_machine_idx
  on public.awish_actions (organization_id, machine_id, kind, created_at desc);

-- Bara utfallet fylls i, en gång (pending → ok/failed/unknown). Inget annat ändras.
create function private.awish_actions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind
     or new.actor_id is distinct from old.actor_id
     or new.actor_role is distinct from old.actor_role
     or new.machine_id is distinct from old.machine_id
     or new.awish_machine_id is distinct from old.awish_machine_id
     or new.target_id is distinct from old.target_id
     or new.request is distinct from old.request
     or new.reason is distinct from old.reason
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception using errcode = '22023',
      message = 'En rad i Awish-loggen kan bara få sitt utfall.';
  end if;
  if old.status <> 'pending' then
    raise exception using errcode = '22023', message = 'Utfallet är redan sparat.';
  end if;
  if new.status = 'pending' then
    raise exception using errcode = '22023', message = 'Utfallet saknas.';
  end if;
  return new;
end
$$;

revoke all on function private.awish_actions_guard() from public;

-- En demo anropar aldrig Awish: bara rader med status 'blocked' får sparas.
create function private.awish_actions_demo_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'blocked'
     and exists (select 1 from public.organizations o
                 where o.id = new.organization_id and o.is_demo) then
    raise exception using
      errcode = 'BL140',
      message = 'Det här är en demo – kopplingar till Awish och andra tjänster är avstängda.';
  end if;
  return new;
end
$$;

revoke all on function private.awish_actions_demo_guard() from public, anon, authenticated, service_role;

create trigger t00_forbid_org_change before update on public.awish_actions
  for each row execute function private.forbid_org_change();
create trigger t01_no_delete before delete on public.awish_actions
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.awish_actions
  for each statement execute function private.forbid_truncate();
create trigger t05_demo_guard before insert on public.awish_actions
  for each row execute function private.awish_actions_demo_guard();
create trigger t20_stamp_insert before insert on public.awish_actions
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.awish_actions
  for each row execute function private.stamp_update();
create trigger t30_guard before update on public.awish_actions
  for each row execute function private.awish_actions_guard();
create trigger t90_audit after insert or update on public.awish_actions
  for each row execute function private.audit();

alter table public.awish_actions alter column organization_id set statistics 0;

alter table public.awish_actions enable row level security;
revoke all on table public.awish_actions from anon, authenticated, service_role;
grant select on table public.awish_actions to authenticated;
grant select, insert, update on table public.awish_actions to service_role;

create policy awish_actions_select on public.awish_actions
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 3. machine_power_schedules
-- -----------------------------------------------------------------------------
create table public.machine_power_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  weekdays text not null check (weekdays ~ '^[01]{7}$'),
  power_on text not null check (power_on ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  power_off text not null check (power_off ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  source text not null check (source in ('store', 'custom')),
  status text not null check (status in ('sent', 'failed', 'cleared')),
  sent_at timestamptz,
  sent_by uuid references auth.users (id) on delete set null,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  awish_action_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, machine_id),
  check (power_on <> power_off),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  foreign key (organization_id, awish_action_id)
    references public.awish_actions (organization_id, id) on delete restrict
);

comment on table public.machine_power_schedules is
  'Automatens strömschema som det skickades till Awish (veckodagar Mån..Sön, på/av HH:MM). Skrivs bara av servern.';

create trigger t00_forbid_org_change before update on public.machine_power_schedules
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.machine_power_schedules
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.machine_power_schedules
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.machine_power_schedules
  for each row execute function private.audit();

alter table public.machine_power_schedules alter column organization_id set statistics 0;

alter table public.machine_power_schedules enable row level security;
revoke all on table public.machine_power_schedules from anon, authenticated, service_role;
grant select on table public.machine_power_schedules to authenticated;
grant select, insert, update, delete on table public.machine_power_schedules to service_role;

create policy machine_power_schedules_select on public.machine_power_schedules
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
  );

-- -----------------------------------------------------------------------------
-- 4. pg_cron: Version-kontrollen varje timme (minut 41)
-- -----------------------------------------------------------------------------
create or replace function private.awish_version_cron_tick()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.cron_call('awish_version', '/api/cron/awish-version', 60000);
end
$$;

revoke all on function private.awish_version_cron_tick() from public, anon, authenticated, service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null
     and to_regnamespace('net') is not null then
    begin
      if exists (select 1 from cron.job where jobname = 'binderlab-awish-version') then
        perform cron.unschedule('binderlab-awish-version');
      end if;
      perform cron.schedule('binderlab-awish-version', '41 * * * *',
                            'select private.awish_version_cron_tick()');
    exception when others then
      raise warning 'Awish Version-kontrollens schema (pg_cron) kunde inte sättas: %', sqlerrm;
    end;
  end if;
end
$$;
