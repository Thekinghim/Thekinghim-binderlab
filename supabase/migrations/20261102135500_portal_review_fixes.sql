-- =============================================================================
-- Butiksportalen (fas 10), del 3: rättelser efter granskningen.
--
-- 1. Butiken ser bara GODKÄNDA butiksrapporter. En rapport (public.reports) är ett
--    utkast tills en ägare eller admin godkänt just den versionen
--    (public.report_approvals, 20261102104410_rapporter_report_approvals.sql).
--    portal_reports, portal_report och storage-policyn för PDF:en kräver nu ett
--    godkännande. Ett utkast ger samma fel som en rapport som inte finns.
-- 2. Felanmälningarna känns igen på VEM som gjort dem (created_by är en
--    butiksanvändare för butiken), inte på typen. Operatören kan byta typ i
--    Inkorgen utan att anmälan försvinner ur butikens lista. Dygnsgränsen räknar
--    på samma sätt.
-- 3. Försäljningen räknar bara order med titelkoppling, som appens beräkningar och
--    butiksrapporten (src/server/data/core/queries.ts hoppar över order utan titel).
--    Portalen och den officiella rapporten visar då samma belopp.
--
-- Funktionernas signaturer, rättigheter och felkoder är oförändrade.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Godkända rapporter
-- -----------------------------------------------------------------------------

-- Är rapporten godkänd av ägare eller admin?
create function private.portal_report_approved(p_organization_id uuid, p_report_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.report_approvals a
    where a.organization_id = p_organization_id and a.report_id = p_report_id
  )
$$;

revoke all on function private.portal_report_approved(uuid, uuid) from public, anon;

create or replace function private.portal_can_read_report_file(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_name is not null and exists (
    select 1
    from public.reports r
    join public.memberships m
      on m.organization_id = r.organization_id and m.store_id = r.store_id
    join public.organizations o on o.id = r.organization_id
    join public.stores s on s.organization_id = r.organization_id and s.id = r.store_id
    where r.storage_path = p_name
      and r.kind = 'store_statement'
      and r.organization_id = private.storage_path_org(p_name)
      and m.user_id = (select auth.uid())
      and m.role = 'store'
      and o.archived_at is null
      and s.archived_at is null
      and private.portal_report_approved(r.organization_id, r.id)
  )
$$;

create or replace function public.portal_reports(p_store_id uuid)
returns table (
  report_id uuid,
  period_start date,
  period_end date,
  generated_at timestamptz,
  has_pdf boolean,
  has_report boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select r.id, r.period_start, r.period_end, r.generated_at, r.storage_path is not null,
           private.portal_store_report(r.data_snapshot, p_store_id) is not null
    from public.reports r
    where r.organization_id = v_org
      and r.store_id = p_store_id
      and r.kind = 'store_statement'
      and private.portal_report_approved(r.organization_id, r.id)
    order by r.period_start desc, r.generated_at desc;
end
$$;

create or replace function public.portal_report(p_store_id uuid, p_report_id uuid)
returns table (
  report_id uuid,
  period_start date,
  period_end date,
  generated_at timestamptz,
  storage_path text,
  report jsonb
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select r.id, r.period_start, r.period_end, r.generated_at, r.storage_path,
           private.portal_store_report(r.data_snapshot, p_store_id)
    from public.reports r
    where r.organization_id = v_org
      and r.store_id = p_store_id
      and r.kind = 'store_statement'
      and r.id = p_report_id
      and private.portal_report_approved(r.organization_id, r.id);
  if not found then
    raise exception using errcode = 'P0002', message = 'Rapporten finns inte.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Felanmälningar känns igen på butiksanvändaren
-- -----------------------------------------------------------------------------

create or replace function public.portal_report_fault(
  p_store_id uuid,
  p_machine_id uuid,
  p_kind text,
  p_description text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
  v_today date;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_id uuid;
begin
  if p_kind is null or p_kind not in (
    'store_payment', 'store_stuck', 'store_empty', 'store_screen', 'store_damage', 'store_other'
  ) then
    raise exception using errcode = '22023', message = 'Välj vad som är fel.';
  end if;
  if v_description is not null and char_length(v_description) > 1000 then
    raise exception using errcode = '22023', message = 'Beskrivningen får vara högst 1 000 tecken.';
  end if;
  if p_kind = 'store_other' and v_description is null then
    raise exception using errcode = '22023', message = 'Beskriv vad som är fel.';
  end if;

  select (now() at time zone o.timezone)::date into v_today
  from public.organizations o where o.id = v_org;

  if p_machine_id is null or not exists (
    select 1 from public.machine_placements mp
    where mp.organization_id = v_org
      and mp.store_id = p_store_id
      and mp.machine_id = p_machine_id
      and mp.valid_from <= v_today
      and (mp.valid_to is null or mp.valid_to >= v_today)
  ) then
    raise exception using errcode = '22023', message = 'Automaten står inte i butiken.';
  end if;

  if (
    select count(*) from public.incidents i
    where i.organization_id = v_org
      and i.created_by = (select auth.uid())
      and i.created_at > now() - interval '24 hours'
  ) >= 20 then
    raise exception using
      errcode = 'BL030',
      message = 'Ni har gjort många felanmälningar det senaste dygnet. Ring operatören om det är bråttom.';
  end if;

  insert into public.incidents (organization_id, machine_id, kind, started_at, description)
  values (v_org, p_machine_id, p_kind, now(), v_description)
  returning id into v_id;
  return v_id;
end
$$;

-- Felanmälningar som butikens användare gjort på automater i butiken, med
-- ärendets status. Känns igen på created_by (butiksanvändare kan bara skapa
-- ärenden via portal_report_fault), så typen får ändras i Inkorgen. Operatörens
-- anteckningar (action_taken), ansvarig och återbetalningar lämnas inte ut.
create or replace function public.portal_faults(p_store_id uuid)
returns table (
  incident_id uuid,
  machine_id uuid,
  kind text,
  description text,
  status text,
  reported_at timestamptz,
  resolved_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select i.id, i.machine_id, i.kind, i.description, i.status, i.started_at, i.ended_at
    from public.incidents i
    join public.organizations o on o.id = i.organization_id
    where i.organization_id = v_org
      and i.created_by in (
        select m.user_id from public.memberships m
        where m.organization_id = v_org and m.store_id = p_store_id and m.role = 'store'
      )
      and exists (
        select 1 from public.machine_placements mp
        where mp.organization_id = v_org
          and mp.store_id = p_store_id
          and mp.machine_id = i.machine_id
          and mp.valid_from <= (i.started_at at time zone o.timezone)::date
          and (mp.valid_to is null or mp.valid_to >= (i.started_at at time zone o.timezone)::date)
      )
    order by i.started_at desc
    limit 100;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Försäljning: bara order med titel (som appens beräkningar)
-- -----------------------------------------------------------------------------

create or replace function public.portal_sales(p_store_id uuid, p_from date, p_to date)
returns table (
  business_date date,
  machine_id uuid,
  title_id uuid,
  title_name text,
  amount_ore bigint,
  order_count bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'Ange en period på högst tre år.';
  end if;
  return query
    select o.business_date, o.machine_id, o.title_id, t.name, o.amount_ore, count(*)
    from public.orders o
    join public.machine_placements mp
      on mp.organization_id = o.organization_id
     and mp.machine_id = o.machine_id
     and mp.store_id = p_store_id
     and o.business_date >= mp.valid_from
     and (mp.valid_to is null or o.business_date <= mp.valid_to)
    join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
    where o.organization_id = v_org
      and o.title_id is not null
      and o.business_date between p_from and p_to
    group by o.business_date, o.machine_id, o.title_id, t.name, o.amount_ore
    order by o.business_date, o.machine_id, t.name, o.amount_ore;
end
$$;

-- Rättigheterna följer med create or replace; sätts om för tydlighets skull.
revoke all on function private.portal_can_read_report_file(text) from public, anon;
grant execute on function private.portal_can_read_report_file(text) to authenticated;
revoke all on function public.portal_sales(uuid, date, date) from public, anon;
revoke all on function public.portal_reports(uuid) from public, anon;
revoke all on function public.portal_report(uuid, uuid) from public, anon;
revoke all on function public.portal_report_fault(uuid, uuid, text, text) from public, anon;
revoke all on function public.portal_faults(uuid) from public, anon;
grant execute on function public.portal_sales(uuid, date, date) to authenticated;
grant execute on function public.portal_reports(uuid) to authenticated;
grant execute on function public.portal_report(uuid, uuid) to authenticated;
grant execute on function public.portal_report_fault(uuid, uuid, text, text) to authenticated;
grant execute on function public.portal_faults(uuid) to authenticated;
