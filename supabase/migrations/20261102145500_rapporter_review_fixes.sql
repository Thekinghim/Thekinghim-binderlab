-- =============================================================================
-- Rapporter (fas 6), del 2: rättelser efter granskningen.
--
-- 1. report_files: en rad när rapportens PDF faktiskt har sparats i lagringen
--    (append-only, en per rapport och filtyp). Arkivet visar "PDF finns" utifrån
--    den här raden i stället för reports.storage_path, som sätts redan när
--    utkastet skapas (databasen kräver en sökväg på varje rapport).
-- 2. reports.storage_path är låst till "{organization_id}/{ÅÅÅÅ-MM}/{id}.pdf" för
--    inloggade användare. En ägare eller admin kan alltså inte peka om en rapport
--    till en annan rapports PDF (som butiksportalens lagringsregel då skulle lämna
--    ut till fel butik).
-- 3. report_deliveries: ett utskick kan bara loggas för en godkänd rapport, även
--    direkt mot databasen.
-- 4. Butiksportalen visar bara den SENASTE godkända versionen av en rapport.
--    private.portal_report_approved (20261102135500_portal_review_fixes.sql) används
--    av portal_reports, portal_report och lagringsregeln för PDF:en; den ersätts
--    här med samma signatur och kräver nu också att ingen nyare version av samma
--    rapport (typ, period, butik) är godkänd. En version som godkänts men ersatts
--    av en nyare godkänd version syns alltså inte längre för butiken.
--
-- Kontrollerna i 2 och 3 gäller inloggade användare (auth.uid() satt). Systemets
-- egna skrivningar (migreringar, testfixturer, det schemalagda jobbet) berörs inte.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. report_files
-- -----------------------------------------------------------------------------

create table public.report_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  report_id uuid not null,
  kind text not null check (kind in ('pdf')),
  storage_path text not null
    check (private.storage_path_org(storage_path) is not distinct from organization_id),
  byte_size integer not null check (byte_size > 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, report_id, kind),
  foreign key (organization_id, report_id) references public.reports (organization_id, id)
    on delete restrict
);

-- Filen ska ligga där rapporten säger att den ligger.
create function private.report_files_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.reports r
    where r.organization_id = new.organization_id
      and r.id = new.report_id
      and r.storage_path = new.storage_path
  ) then
    raise exception using errcode = '23514', message = 'Filen hör inte till rapporten.';
  end if;
  return new;
end
$$;

revoke all on function private.report_files_check() from public;

create trigger t00_forbid_org_change before update on public.report_files
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.report_files
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.report_files
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.report_files
  for each row execute function private.stamp_insert();
create trigger t30_check before insert on public.report_files
  for each row execute function private.report_files_check();
create trigger t90_audit after insert on public.report_files
  for each row execute function private.audit();

alter table public.report_files alter column organization_id set statistics 0;

alter table public.report_files enable row level security;
revoke all on table public.report_files from anon, authenticated;
grant select, insert on table public.report_files to authenticated;

create policy report_files_select on public.report_files
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy report_files_insert on public.report_files
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 2. reports.storage_path är låst till rapportens egen sökväg
-- -----------------------------------------------------------------------------

create function private.reports_storage_path_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     and new.storage_path is distinct from
       new.organization_id::text || '/' || to_char(new.period_start, 'YYYY-MM') || '/'
         || new.id::text || '.pdf'
  then
    raise exception using
      errcode = '23514',
      message = 'Rapportens PDF har en fast sökväg och kan inte pekas om.';
  end if;
  return new;
end
$$;

revoke all on function private.reports_storage_path_check() from public;

create trigger t05_storage_path before insert or update of storage_path on public.reports
  for each row execute function private.reports_storage_path_check();

-- -----------------------------------------------------------------------------
-- 3. Utskick kräver godkännande
-- -----------------------------------------------------------------------------

create function private.report_deliveries_require_approval() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not exists (
    select 1 from public.report_approvals a
    where a.organization_id = new.organization_id and a.report_id = new.report_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Rapporten måste godkännas innan den skickas.';
  end if;
  return new;
end
$$;

revoke all on function private.report_deliveries_require_approval() from public;

create trigger t30_require_approval before insert on public.report_deliveries
  for each row execute function private.report_deliveries_require_approval();

-- -----------------------------------------------------------------------------
-- 4. Portalen: bara den senaste godkända versionen
-- -----------------------------------------------------------------------------

-- Är rapporten godkänd, och finns ingen nyare godkänd version av samma rapport?
-- "Nyare" = senare generated_at (lika: högre id), samma regel som arkivets
-- status "ersatt" (src/server/reports/status.ts).
create or replace function private.portal_report_approved(p_organization_id uuid, p_report_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.report_approvals a
    where a.organization_id = p_organization_id and a.report_id = p_report_id
  )
  and not exists (
    select 1
    from public.reports r
    join public.reports n
      on n.organization_id = r.organization_id
     and n.kind = r.kind
     and n.period_start = r.period_start
     and n.period_end = r.period_end
     and n.store_id is not distinct from r.store_id
     and (n.generated_at > r.generated_at or (n.generated_at = r.generated_at and n.id > r.id))
    join public.report_approvals na
      on na.organization_id = n.organization_id and na.report_id = n.id
    where r.organization_id = p_organization_id and r.id = p_report_id
  )
$$;

revoke all on function private.portal_report_approved(uuid, uuid) from public, anon;
