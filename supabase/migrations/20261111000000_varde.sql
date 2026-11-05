-- =============================================================================
-- Värde: "Vad Binderlab gett dig" (/varde) och månadsrapporten (docs/berakningar.md 27).
--
-- 1. automation_log: logg över arbete som Binderlab gör automatiskt och som inte syns
--    i någon annan tabell. I dag bara 'awish_push': en automat vars fack Binderlab satte
--    i Awish efter en påfyllning (src/server/awish/web-service.ts). En rad per automat och
--    körning, med antal fack som ändrades. Skrivs bara av servern (systemrollen), aldrig
--    av klientroller. Append-only. Ägare och admin läser.
-- 2. public.varde_automation_counts(org, från, till): antal uppgifter per månad och sort
--    för sidan Värde (sparad tid). Ägare och admin. Räknar i organisationens tidszon:
--    - refill_visit: automat och dag med minst en registrerad påfyllning,
--    - awish_push:   automater som skickades till Awish (automation_log),
--    - settlement:   butiksavräkningar som räknats fram (store_settlements.created_at),
--    - bookkeeping:  bokföringspaket som skapats (bookkeeping_packages.generated_at),
--    - alert:        larmutskick som gått iväg (alert_deliveries sent/partial),
--    - report:       rapporter som skickats till en mottagare (report_deliveries sent/delivered).
--    Returnerar bara rader med antal > 0.
--
-- Allt är additivt: en ny tabell och en ny funktion.
-- =============================================================================

create table public.automation_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('awish_push')),
  machine_id uuid,
  -- Antal fack (awish_push) som ändrades.
  units integer not null default 0 check (units between 0 and 10000),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete set null (machine_id)
);

create index automation_log_org_time_idx
  on public.automation_log (organization_id, occurred_at);

create trigger t00_forbid_org_change before update on public.automation_log
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.automation_log
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.automation_log
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.automation_log
  for each row execute function private.stamp_insert();

alter table public.automation_log alter column organization_id set statistics 0;

alter table public.automation_log enable row level security;
revoke all on table public.automation_log from anon, authenticated;
grant select on table public.automation_log to authenticated;

create policy automation_log_select on public.automation_log
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

comment on table public.automation_log is
  'Arbete som Binderlab gjort automatiskt (awish_push). Skrivs av servern, append-only.';

-- -----------------------------------------------------------------------------
-- Antal uppgifter per månad (sidan Värde)
-- -----------------------------------------------------------------------------
create function public.varde_automation_counts(
  p_organization_id uuid,
  p_from date,
  p_to date
) returns table (month date, kind text, n integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
begin
  if not private.has_role(p_organization_id, 'owner'::public.member_role, 'admin'::public.member_role) then
    raise exception 'Bara ägare och administratörer ser värdet.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'Ogiltig period.' using errcode = '22023';
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = p_organization_id;
  v_from := (p_from::timestamp) at time zone v_tz;
  v_to := ((p_to + 1)::timestamp) at time zone v_tz;

  return query
  with items as (
    -- Påfyllning: automat och dag (affärsdatum).
    select date_trunc('month', e.business_date)::date as m, 'refill_visit'::text as k,
           count(distinct (e.location_id, e.business_date))::int as n
    from public.stock_events e
    join public.stock_locations l
      on l.organization_id = e.organization_id and l.id = e.location_id
    where e.organization_id = p_organization_id
      and l.kind = 'machine'
      and e.kind = 'refill'
      and e.business_date between p_from and p_to
    group by 1
    union all
    select date_trunc('month', a.occurred_at at time zone v_tz)::date, 'awish_push', count(*)::int
    from public.automation_log a
    where a.organization_id = p_organization_id and a.kind = 'awish_push'
      and a.occurred_at >= v_from and a.occurred_at < v_to
    group by 1
    union all
    select date_trunc('month', s.created_at at time zone v_tz)::date, 'settlement', count(*)::int
    from public.store_settlements s
    where s.organization_id = p_organization_id
      and s.created_at >= v_from and s.created_at < v_to
    group by 1
    union all
    select date_trunc('month', b.generated_at at time zone v_tz)::date, 'bookkeeping', count(*)::int
    from public.bookkeeping_packages b
    where b.organization_id = p_organization_id
      and b.generated_at >= v_from and b.generated_at < v_to
    group by 1
    union all
    select date_trunc('month', coalesce(d.sent_at, d.send_at) at time zone v_tz)::date, 'alert',
           count(*)::int
    from public.alert_deliveries d
    where d.organization_id = p_organization_id
      and d.status in ('sent', 'partial')
      and coalesce(d.sent_at, d.send_at) >= v_from and coalesce(d.sent_at, d.send_at) < v_to
    group by 1
    union all
    select date_trunc('month', coalesce(r.sent_at, r.created_at) at time zone v_tz)::date, 'report',
           count(*)::int
    from public.report_deliveries r
    where r.organization_id = p_organization_id
      and r.status in ('sent', 'delivered')
      and coalesce(r.sent_at, r.created_at) >= v_from and coalesce(r.sent_at, r.created_at) < v_to
    group by 1
  )
  select i.m, i.k, i.n from items i where i.n > 0 order by i.m, i.k;
end;
$$;

revoke all on function public.varde_automation_counts(uuid, date, date) from public, anon;
grant execute on function public.varde_automation_counts(uuid, date, date) to authenticated;

comment on function public.varde_automation_counts(uuid, date, date) is
  'Värde: antal uppgifter Binderlab gjort per månad och sort (ägare, admin).';
