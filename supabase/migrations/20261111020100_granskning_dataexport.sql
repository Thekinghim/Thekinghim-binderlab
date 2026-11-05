-- =============================================================================
-- Granskning och oberoende:
--
-- 1. Täckningen per automat (private.sales_data_until_rows) räknar 'manual_csv' som en
--    uppladdad källa, precis som 'awish_csv': datat räcker till den senaste ordern i
--    filen, inte till när filen laddades upp. Annars som 20261102150500.
--
-- 2. data_exports: logg över "Exportera all data" (Inställningar). En rad per export,
--    skrivs bara av start_data_export. Ägaren läser loggen. Raderna ändras och raderas
--    aldrig (append-only).
--
-- 3. start_data_export(org) → id. Bara ägaren. Högst 3 exporter per organisation och
--    timme (BL094), räknat i databasen (gäller alla serverinstanser). Själva datat läses sedan
--    av servern under användarens RLS (src/server/export).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Täckningen: manual_csv är manuell (som awish_csv)
-- -----------------------------------------------------------------------------
create or replace function private.sales_data_until_rows(p_organization_id uuid, p_at timestamptz)
returns table (
  machine_id uuid,
  data_source_id uuid,
  source_name text,
  manual boolean,
  data_until timestamptz,
  synced_at timestamptz,
  last_order_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  with src as (
    select d.id, d.name, d.provider,
           (d.provider in ('awish_csv', 'manual_csv')) as manual,
           greatest(
             d.last_synced_at,
             (select max(i.finished_at) from public.imports i
              where i.organization_id = d.organization_id and i.data_source_id = d.id
                and i.status = 'succeeded' and i.finished_at <= p_at)
           ) as synced_at,
           (select max(o.ordered_at) from public.orders o
            where o.organization_id = d.organization_id and o.data_source_id = d.id
              and o.ordered_at <= p_at and o.ordered_at > p_at - interval '70 days') as last_order_at
    from public.data_sources d
    where d.organization_id = p_organization_id and d.archived_at is null
  ),
  cov as (
    select src.*,
           case when src.manual then src.last_order_at
                else least(greatest(src.synced_at, src.last_order_at), p_at) end as until_at
    from src
  ),
  latest as (
    select distinct on (o.machine_id) o.machine_id, o.data_source_id, o.ordered_at
    from public.orders o
    where o.organization_id = p_organization_id and o.machine_id is not null
      and o.ordered_at <= p_at and o.ordered_at > p_at - interval '70 days'
    order by o.machine_id, o.ordered_at desc
  ),
  fallback as (
    select * from cov where cov.until_at is not null order by cov.until_at desc limit 1
  )
  select m.id,
         coalesce(c.id, f.id),
         coalesce(c.name, f.name),
         coalesce(c.manual, f.manual),
         coalesce(c.until_at, f.until_at),
         coalesce(c.synced_at, f.synced_at),
         l.ordered_at
  from public.machines m
  left join latest l on l.machine_id = m.id
  left join cov c on c.id = l.data_source_id
  left join fallback f on c.id is null
  where m.organization_id = p_organization_id and m.archived_at is null
    and ((select auth.uid()) is null
         or private.has_role(p_organization_id, 'owner', 'admin', 'viewer', 'refiller'))
$$;

-- -----------------------------------------------------------------------------
-- 2. data_exports
-- -----------------------------------------------------------------------------
create table public.data_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  format text not null default 'zip-csv' check (format in ('zip-csv')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id)
);

comment on table public.data_exports is
  'Logg över "Exportera all data" (Inställningar). Bara via start_data_export; append-only.';

-- Som övriga tabeller: ingen planerarstatistik på organization_id (test/db/hardening.test.ts).
alter table public.data_exports alter column organization_id set statistics 0;

create index data_exports_org_time_idx on public.data_exports (organization_id, created_at desc);

create trigger t00_forbid_org_change before update on public.data_exports
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.data_exports
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.data_exports
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.data_exports
  for each row execute function private.stamp_insert();

alter table public.data_exports enable row level security;
revoke all on table public.data_exports from anon, authenticated;
grant select on table public.data_exports to authenticated;

create policy data_exports_select on public.data_exports
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner'))));

-- -----------------------------------------------------------------------------
-- 3. start_data_export(org) → id
-- -----------------------------------------------------------------------------
create function public.start_data_export(p_organization_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_recent int;
  v_id uuid;
begin
  if not private.has_role(p_organization_id, 'owner') then
    raise exception using errcode = '42501', message = 'Bara ägaren kan exportera all data.';
  end if;
  -- En export i taget per organisation: två samtidiga anrop räknas efter varandra.
  perform pg_advisory_xact_lock(hashtextextended('binderlab:data_export:' || p_organization_id::text, 0));
  select count(*)::int into v_recent
  from public.data_exports e
  where e.organization_id = p_organization_id and e.created_at > now() - interval '1 hour';
  if v_recent >= 3 then
    raise exception using errcode = 'BL094',
      message = 'Högst 3 exporter per timme. Försök igen senare.';
  end if;
  insert into public.data_exports (organization_id) values (p_organization_id)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function public.start_data_export(uuid) from public, anon;
grant execute on function public.start_data_export(uuid) to authenticated;
