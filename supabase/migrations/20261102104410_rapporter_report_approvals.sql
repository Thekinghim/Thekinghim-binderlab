-- =============================================================================
-- Rapporter: godkännande av en skapad rapport (report_approvals).
--
-- En rapport (public.reports) skapas som utkast: underlaget (data_snapshot) och
-- beräkningsversionen sparas och ändras aldrig. Innan den får skickas måste en
-- ägare eller admin godkänna just den versionen. Godkännandet är en egen rad
-- (append-only, en per rapport), så att vem som godkände och när finns kvar och
-- syns i ändringsloggen. Ska något ändras (hälsning, kommentar, nya order) skapas
-- en ny rapport, som måste godkännas för sig.
--
-- Status i arkivet räknas fram av appen (src/server/reports):
--   utkast   = inget godkännande
--   godkänd  = godkännande men inget lyckat utskick
--   skickad  = minst ett utskick med status queued/sent/delivered
--   öppnad   = (senare) leverantörens webhook rapporterar öppnat
--
-- Behörighet: ägare, admin och läsare får läsa. Bara ägare och admin får
-- godkänna, och bara i eget namn (approved_by = auth.uid()). Påfyllaren ser
-- ingenting (tabellen finns inte i påfyllarens tillåtlista).
-- =============================================================================

create table public.report_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  report_id uuid not null,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz not null default now(),
  -- Valfri anteckning vid godkännandet ("Kontrollerad mot Awish").
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, report_id),
  foreign key (organization_id, report_id) references public.reports (organization_id, id)
    on delete restrict
);

-- Vem och när sätts av databasen för inloggade användare.
create function private.report_approvals_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new.approved_by := v_uid;
  end if;
  new.approved_at := now();
  return new;
end
$$;

revoke all on function private.report_approvals_stamp() from public;

create trigger t00_forbid_org_change before update on public.report_approvals
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.report_approvals
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.report_approvals
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.report_approvals
  for each row execute function private.stamp_insert();
create trigger t30_approval_stamp before insert on public.report_approvals
  for each row execute function private.report_approvals_stamp();
create trigger t90_audit after insert on public.report_approvals
  for each row execute function private.audit();

create index report_approvals_org_idx on public.report_approvals (organization_id, approved_at desc);

alter table public.report_approvals alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------
alter table public.report_approvals enable row level security;
revoke all on table public.report_approvals from anon, authenticated;
grant select, insert on table public.report_approvals to authenticated;

create policy report_approvals_select on public.report_approvals
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));

create policy report_approvals_insert on public.report_approvals
  for insert to authenticated
  with check (
    approved_by = (select auth.uid())
    and organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );
