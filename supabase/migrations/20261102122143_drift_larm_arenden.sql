-- =============================================================================
-- Drift (fas 8): larm, prenumerationer, push, utskick, kundärenden och
-- påfyllning från fältet.
--
-- 1. alerts utökas med incidentens tillstånd (src/analytics/alerts:
--    AlertIncident). En rad = ett problem över tid, med nyckel (incident_key,
--    t.ex. 'machine:<id>'). Högst en öppen rad per nyckel (unikt index), så att
--    samma problem aldrig blir tio larm. Raderna skrivs av larmjobbet
--    (/api/cron/larm, systemroll); användare får bara kvittera.
-- 2. alert_subscriptions: vilka larm en användare vill ha, för vilka automater,
--    vilka tider och via vilka kanaler. En rad per användare och organisation.
-- 3. push_subscriptions: webbläsarens push-prenumeration (Web Push) per enhet.
-- 4. alert_deliveries: utskick per användare och sändtid (kön för uppskjutna
--    utskick vid tysta timmar och loggen över skickade).
-- 5. incidents (kundärenden) utökas med status, ansvarig, order, titel,
--    återbetalt belopp (öre) och återbetalningsdag. Återbetalningar påverkar
--    lönsamheten (src/domain/refunds.ts) och spärras därför i stängda månader.
-- 6. field_submissions och register_refill_once: påfyllning som sparats offline
--    i fältet synkas idempotent med ett id som klienten skapat.
--
-- Påfyllaren: ser larm om automater och lager (inte import eller försäljning),
-- egna prenumerationer, egna push-enheter, egna utskick och egna offline-
-- inskick. Aldrig kundärenden (återbetalningar är ekonomi).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. alerts: incidentens tillstånd
-- -----------------------------------------------------------------------------
alter table public.alerts
  add column incident_key text
    check (incident_key is null or (char_length(incident_key) between 3 and 300
                                    and incident_key ~ '^[a-z][a-z_]*:[^[:space:]]+$')),
  add column alert_group text
    check (alert_group is null or alert_group in ('machine', 'stock', 'import', 'sales')),
  add column status text not null default 'open' check (status in ('open', 'closed')),
  add column title text check (title is null or char_length(title) <= 300),
  add column evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  add column link text
    check (link is null or (char_length(link) <= 500 and link ~ '^/[^/\\]')),
  add column last_seen_at timestamptz,
  add column closed_at timestamptz,
  add column last_notified_at timestamptz,
  add column notified_severity public.alert_severity,
  add column notify_count integer not null default 0 check (notify_count >= 0),
  add column occurrences integer not null default 1 check (occurrences >= 0),
  add column reopen_count integer not null default 0 check (reopen_count >= 0),
  add column one_shot boolean not null default false,
  add column resolved_notified_at timestamptz,
  add column suppressed_by text check (suppressed_by is null or char_length(suppressed_by) <= 300),
  add constraint alerts_closed_at_status check ((status = 'closed') = (closed_at is not null)),
  add constraint alerts_message_length check (message is null or char_length(message) <= 2000);

-- Samma problem är högst en öppen incident.
create unique index alerts_open_key_uq on public.alerts (organization_id, incident_key)
  where status = 'open' and incident_key is not null;
create index alerts_org_key_idx on public.alerts (organization_id, incident_key, triggered_at desc);
create index alerts_org_status_idx on public.alerts (organization_id, status, triggered_at desc);

-- Klienter får bara kvittera. Allt annat skrivs av larmjobbet.
revoke insert, update on table public.alerts from authenticated;
grant update (acknowledged_at, acknowledged_by) on table public.alerts to authenticated;
drop policy alerts_insert on public.alerts;

-- Kvittering: den som kvitterar är alltid den inloggade.
create function private.alerts_ack_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null and new.acknowledged_at is distinct from old.acknowledged_at then
    if new.acknowledged_at is null then
      new.acknowledged_by := null;
    else
      new.acknowledged_at := now();
      new.acknowledged_by := v_uid;
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.alerts_ack_stamp() from public;

create trigger t30_ack_stamp before update on public.alerts
  for each row execute function private.alerts_ack_stamp();

-- Påfyllaren ser larm om automater och lager.
create policy alerts_select_refiller on public.alerts
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('refiller')))
    and alert_group in ('machine', 'stock')
  );

-- -----------------------------------------------------------------------------
-- 2. alert_subscriptions
-- -----------------------------------------------------------------------------
create function private.alert_kinds_valid(p_kinds text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_kinds is null or (
    cardinality(p_kinds) between 1 and 6
    and p_kinds <@ array['machine_suspected_fault', 'machine_fault', 'machine_offline',
                         'low_stock', 'import_failed', 'day_anomaly']::text[]
  )
$$;
revoke all on function private.alert_kinds_valid(text[]) from public, anon;
grant execute on function private.alert_kinds_valid(text[]) to authenticated;

-- Larmtyper som rör automater och lager (det påfyllaren får).
create function private.alert_kinds_are_field(p_kinds text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_kinds is not null
    and p_kinds <@ array['machine_suspected_fault', 'machine_fault', 'machine_offline',
                         'low_stock']::text[]
$$;
revoke all on function private.alert_kinds_are_field(text[]) from public, anon;
grant execute on function private.alert_kinds_are_field(text[]) to authenticated;

create table public.alert_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- null = alla typer.
  kinds text[] check (private.alert_kinds_valid(kinds)),
  -- null = alla automater. Larm utan automat (import, hela organisationen) påverkas inte.
  machine_ids uuid[] check (machine_ids is null or cardinality(machine_ids) between 1 and 500),
  min_severity public.alert_severity not null default 'warning',
  channels text[] not null default array['push', 'email']::text[]
    check (cardinality(channels) between 1 and 3 and channels <@ array['push', 'email', 'sms']::text[]),
  -- E.164, bara för sms.
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- Tysta timmar i organisationens tidszon, 'TT:MM'. start > end = över midnatt.
  quiet_start text check (quiet_start is null or quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end text check (quiet_end is null or quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- [{ "days": [1,2,3,4,5], "start": "07:00", "end": "18:00" }]; null = alla tider.
  delivery_windows jsonb
    check (delivery_windows is null or (jsonb_typeof(delivery_windows) = 'array'
                                        and jsonb_array_length(delivery_windows) between 1 and 14)),
  critical_during_quiet boolean not null default true,
  notify_resolved boolean not null default false,
  reminders boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id),
  check ((quiet_start is null) = (quiet_end is null)),
  check (not ('sms' = any (channels)) or phone is not null)
);

create trigger t00_forbid_org_change before update on public.alert_subscriptions
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.alert_subscriptions
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.alert_subscriptions
  for each row execute function private.stamp_update();

alter table public.alert_subscriptions alter column organization_id set statistics 0;

alter table public.alert_subscriptions enable row level security;
revoke all on table public.alert_subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.alert_subscriptions to authenticated;

-- Var och en ser och ändrar bara sin egen prenumeration. Påfyllaren bara för
-- larm om automater och lager.
create policy alert_subscriptions_select on public.alert_subscriptions
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer', 'refiller')))
  );
create policy alert_subscriptions_insert on public.alert_subscriptions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
      or (
        organization_id = any (array(select private.orgs_with_role('refiller')))
        and private.alert_kinds_are_field(kinds)
      )
    )
  );
create policy alert_subscriptions_update on public.alert_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
      or (
        organization_id = any (array(select private.orgs_with_role('refiller')))
        and private.alert_kinds_are_field(kinds)
      )
    )
  );
create policy alert_subscriptions_delete on public.alert_subscriptions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 3. push_subscriptions (Web Push, en rad per webbläsare/enhet)
-- -----------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null check (char_length(endpoint) between 12 and 2000 and endpoint ~ '^https://'),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth_secret text not null check (char_length(auth_secret) between 8 and 100),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, endpoint)
);

create trigger t00_forbid_org_change before update on public.push_subscriptions
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.push_subscriptions
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.push_subscriptions
  for each row execute function private.stamp_update();

alter table public.push_subscriptions alter column organization_id set statistics 0;

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, delete on table public.push_subscriptions to authenticated;
grant update (p256dh, auth_secret, user_agent, disabled_at) on table public.push_subscriptions
  to authenticated;

create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer', 'refiller')))
  );
create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer', 'refiller')))
  );
create policy push_subscriptions_update on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 4. alert_deliveries (utskick: kö och logg). Skrivs av larmjobbet.
-- -----------------------------------------------------------------------------
create table public.alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid references auth.users (id) on delete set null,
  send_at timestamptz not null,
  deferred boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'partial', 'failed', 'skipped')),
  subject text not null check (char_length(subject) between 1 and 300),
  -- AlertNotification[] (incident, orsak, titel, text, länk).
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  alert_ids uuid[] not null default '{}',
  -- Utfall per kanal: [{ "channel": "push", "status": "sent", "detail": "…" }].
  results jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create trigger t00_forbid_org_change before update on public.alert_deliveries
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.alert_deliveries
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.alert_deliveries
  for each row execute function private.stamp_update();

create index alert_deliveries_due_idx on public.alert_deliveries (status, send_at)
  where status = 'pending';
create index alert_deliveries_user_idx on public.alert_deliveries (organization_id, user_id, send_at desc);

alter table public.alert_deliveries alter column organization_id set statistics 0;

alter table public.alert_deliveries enable row level security;
revoke all on table public.alert_deliveries from anon, authenticated;
grant select on table public.alert_deliveries to authenticated;

-- Egna utskick; ägare och admin ser alla i organisationen.
create policy alert_deliveries_select on public.alert_deliveries
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      user_id = (select auth.uid())
      and organization_id = any (array(select private.orgs_with_role('viewer', 'refiller')))
    )
  );

-- -----------------------------------------------------------------------------
-- 5. incidents: kundärenden
-- -----------------------------------------------------------------------------
alter table public.incidents
  add column status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved')),
  add column assignee_id uuid references auth.users (id) on delete set null,
  add column order_id uuid,
  add column title_id uuid,
  add column refunded_ore bigint not null default 0 check (refunded_ore between 0 and 100000000),
  add column refunded_on date,
  add column customer_contact text
    check (customer_contact is null or char_length(customer_contact) <= 200),
  add constraint incidents_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete set null (order_id),
  add constraint incidents_title_fk foreign key (organization_id, title_id)
    references public.titles (organization_id, id) on delete set null (title_id),
  add constraint incidents_refund_day check (refunded_ore = 0 or refunded_on is not null),
  add constraint incidents_resolved_ended check ((status = 'resolved') = (ended_at is not null)),
  add constraint incidents_text_length check (
    (description is null or char_length(description) <= 2000)
    and (action_taken is null or char_length(action_taken) <= 2000)
  );

create index incidents_org_started_idx on public.incidents (organization_id, started_at desc);
create index incidents_org_refund_idx on public.incidents (organization_id, refunded_on)
  where refunded_ore > 0;

-- Ordern hör till automaten, och ansvarig är medlem. Körs efter RLS (AFTER).
create function private.incidents_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_machine uuid;
begin
  if new.order_id is not null then
    select o.machine_id into v_machine from public.orders o
    where o.organization_id = new.organization_id and o.id = new.order_id;
    if v_machine is not null and v_machine <> new.machine_id then
      raise exception using errcode = '22023',
        message = 'Ordern kommer från en annan automat än ärendet.';
    end if;
  end if;
  if new.assignee_id is not null and not exists (
    select 1 from public.memberships m
    where m.organization_id = new.organization_id and m.user_id = new.assignee_id
  ) then
    raise exception using errcode = 'BL020',
      message = 'Den ansvariga är inte medlem i organisationen.';
  end if;
  return null;
end
$$;
revoke all on function private.incidents_check() from public;

-- Återbetalningar räknas i lönsamheten: de får inte ändras i en stängd månad.
create function private.incidents_period_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_days datemultirange := '{}'::datemultirange;
begin
  if tg_op = 'UPDATE' then
    if new.refunded_ore is not distinct from old.refunded_ore
       and new.refunded_on is not distinct from old.refunded_on then
      return null;
    end if;
    if old.refunded_ore > 0 and old.refunded_on is not null then
      v_days := v_days + datemultirange(daterange(old.refunded_on, old.refunded_on, '[]'));
    end if;
  end if;
  if new.refunded_ore > 0 and new.refunded_on is not null then
    v_days := v_days + datemultirange(daterange(new.refunded_on, new.refunded_on, '[]'));
  end if;
  if not isempty(v_days) then
    perform private.assert_period_open(new.organization_id, v_days, 'Återbetalningen');
  end if;
  return null;
end
$$;
revoke all on function private.incidents_period_guard() from public;

create trigger "A05_incidents_check" after insert or update on public.incidents
  for each row execute function private.incidents_check();
create trigger t40_period_guard after insert or update on public.incidents
  for each row execute function private.incidents_period_guard();
create trigger t90_audit after insert or update on public.incidents
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- 6. Påfyllning från fältet: idempotent inskick med klientens id
-- -----------------------------------------------------------------------------
create table public.field_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  client_id uuid not null,
  kind text not null default 'refill' check (kind in ('refill')),
  machine_id uuid not null,
  title_id uuid not null,
  quantity integer not null check (quantity between 1 and 10000),
  from_warehouse boolean not null,
  occurred_at timestamptz not null,
  stock_event_id uuid not null,
  submitted_by uuid references auth.users (id) on delete set null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, client_id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict,
  foreign key (organization_id, stock_event_id) references public.stock_events (organization_id, id)
    on delete restrict
);

create trigger t00_forbid_org_change before update on public.field_submissions
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.field_submissions
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.field_submissions
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.field_submissions
  for each row execute function private.forbid_delete();

alter table public.field_submissions alter column organization_id set statistics 0;

alter table public.field_submissions enable row level security;
revoke all on table public.field_submissions from anon, authenticated;
grant select on table public.field_submissions to authenticated;

create policy field_submissions_select on public.field_submissions
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
    or (
      submitted_by = (select auth.uid())
      and organization_id = any (array(select private.orgs_with_role('refiller')))
    )
  );

-- Registrerar en påfyllning en gång per klient-id. Samma id igen (t.ex. när
-- nätet kom tillbaka mitt i ett inskick) ger samma lagerhändelse och inget nytt.
create function public.register_refill_once(
  p_organization_id uuid,
  p_client_id uuid,
  p_machine_id uuid,
  p_title_id uuid,
  p_quantity integer,
  p_from_warehouse boolean default true,
  p_occurred_at timestamptz default null,
  p_note text default null
)
returns table (stock_event_id uuid, duplicate boolean)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_prev public.field_submissions;
  v_event uuid;
  v_at timestamptz := coalesce(p_occurred_at, now());
begin
  if v_uid is null or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan registrera påfyllningar.';
  end if;
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'Inskicket saknar id.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || '/field/' || p_client_id::text, 0)
  );
  select * into v_prev from public.field_submissions f
  where f.organization_id = p_organization_id and f.client_id = p_client_id;
  if v_prev.id is not null then
    if v_prev.submitted_by is distinct from v_uid
       or v_prev.machine_id <> p_machine_id
       or v_prev.title_id <> p_title_id
       or v_prev.quantity <> p_quantity then
      raise exception using errcode = '22023',
        message = 'Id:t används redan för en annan påfyllning.';
    end if;
    return query select v_prev.stock_event_id, true;
    return;
  end if;

  v_event := public.register_refill(
    p_organization_id, p_machine_id, p_title_id, p_quantity, p_from_warehouse, v_at, p_note
  );
  insert into public.field_submissions (
    organization_id, client_id, kind, machine_id, title_id, quantity, from_warehouse,
    occurred_at, stock_event_id, submitted_by
  )
  values (
    p_organization_id, p_client_id, 'refill', p_machine_id, p_title_id, p_quantity,
    coalesce(p_from_warehouse, true), v_at, v_event, v_uid
  );
  return query select v_event, false;
end
$$;

revoke all on function public.register_refill_once(uuid, uuid, uuid, uuid, integer, boolean, timestamptz, text)
  from public, anon;
grant execute on function public.register_refill_once(uuid, uuid, uuid, uuid, integer, boolean, timestamptz, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 7. alert_runs: varje körning av larmjobbet (för "senast utvärderat" och felsökning)
-- -----------------------------------------------------------------------------
create table public.alert_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  ran_at timestamptz not null,
  status text not null check (status in ('ok', 'failed', 'skipped')),
  -- Antal automater, kandidater, öppna incidenter efter körningen, aviseringar och utskick.
  machines integer not null default 0 check (machines >= 0),
  candidates integer not null default 0 check (candidates >= 0),
  open_incidents integer not null default 0 check (open_incidents >= 0),
  notifications integer not null default 0 check (notifications >= 0),
  deliveries integer not null default 0 check (deliveries >= 0),
  -- Varifrån maskinstatusen kom: 'sales' (härledd) eller 'vendor' (leverantörens data).
  health_source text not null default 'sales' check (health_source in ('sales', 'vendor')),
  error text check (error is null or char_length(error) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create trigger t00_forbid_org_change before update on public.alert_runs
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.alert_runs
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.alert_runs
  for each row execute function private.stamp_update();

create index alert_runs_org_idx on public.alert_runs (organization_id, ran_at desc);
alter table public.alert_runs alter column organization_id set statistics 0;

alter table public.alert_runs enable row level security;
revoke all on table public.alert_runs from anon, authenticated;
grant select on table public.alert_runs to authenticated;

create policy alert_runs_select on public.alert_runs
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
