-- =============================================================================
-- Värde, granskning: varde_automation_counts räknar larm och rapporter en gång var.
--
-- alert_deliveries har en rad per användare (och påminnelser), report_deliveries en rad
-- per mottagare. Att räkna rader gav 5 min per användare som fick samma larm och 15 min
-- per mottagare av samma rapport: för mycket. Nu:
--   - alert:  varje larm (alert_ids) en gång, i månaden då det först gick iväg,
--   - report: varje rapport (report_id) en gång, i månaden då den först skickades.
-- Övriga sorter som förut. Signatur och behörighet oförändrade.
-- =============================================================================

create or replace function public.varde_automation_counts(
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
    -- Ett larm räknas en gång, i månaden då det först gick iväg, hur många användare som
    -- än fick det och hur många påminnelser som skickades. Utskick utan larm-id räknas inte.
    select date_trunc('month', f.first_at at time zone v_tz)::date, 'alert', count(*)::int
    from (
      select a.alert_id, min(coalesce(d.sent_at, d.send_at)) as first_at
      from public.alert_deliveries d
      cross join lateral unnest(d.alert_ids) as a(alert_id)
      where d.organization_id = p_organization_id
        and d.status in ('sent', 'partial')
      group by a.alert_id
    ) f
    where f.first_at >= v_from and f.first_at < v_to
    group by 1
    union all
    -- En rapport räknas en gång, i månaden då den först skickades, hur många mottagare
    -- den än gick till.
    select date_trunc('month', f.first_at at time zone v_tz)::date, 'report', count(*)::int
    from (
      select r.report_id, min(coalesce(r.sent_at, r.created_at)) as first_at
      from public.report_deliveries r
      where r.organization_id = p_organization_id
        and r.status in ('sent', 'delivered')
      group by r.report_id
    ) f
    where f.first_at >= v_from and f.first_at < v_to
    group by 1
  )
  select i.m, i.k, i.n from items i where i.n > 0 order by i.m, i.k;
end;
$$;

comment on function public.varde_automation_counts(uuid, date, date) is
  'Värde: antal uppgifter Binderlab gjort per månad och sort (ägare, admin). Larm och rapporter en gång var.';
