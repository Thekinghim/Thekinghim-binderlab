-- =============================================================================
-- Lager: larmgräns per titel och automat (slot_alerts).
--
-- "Larma vid N": när saldot för titeln i automaten är högst N blir det en
-- påfyllningspunkt i Att göra, oavsett försäljningstakten. Ingen rad = av.
--
-- Egen tabell i stället för en kolumn i machine_slots: sortimentet (machine_slots)
-- skrivs om från Marknad (rader tas bort och läggs in igen), och de flesta titlar som
-- står i en automat har ingen fackperiod alls. Gränsen ska finnas kvar oavsett.
--
-- Behörighet: alla roller läser (påfyllaren ser gränsen på Lager, inga belopp).
-- Bara ägare och admin skriver. Ändringar loggas i audit_log av triggern.
-- =============================================================================

create table public.slot_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  title_id uuid not null,
  alert_at_units integer not null check (alert_at_units between 0 and 10000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, machine_id, title_id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict
);

comment on table public.slot_alerts is
  'Larmgräns per automat och titel: saldo högst alert_at_units ger en påfyllningspunkt.';

create trigger t00_forbid_org_change before update on public.slot_alerts
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.slot_alerts
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.slot_alerts
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.slot_alerts
  for each row execute function private.audit();

-- Som övriga tabeller (20261102160000_hardening_org_statistics.sql).
alter table public.slot_alerts alter column organization_id set statistics 0;

alter table public.slot_alerts enable row level security;
revoke all on table public.slot_alerts from anon, authenticated;
grant select, insert, update, delete on table public.slot_alerts to authenticated;
revoke truncate, references, trigger on table public.slot_alerts from authenticated, service_role;

create policy slot_alerts_select on public.slot_alerts for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy slot_alerts_insert on public.slot_alerts for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy slot_alerts_update on public.slot_alerts for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy slot_alerts_delete on public.slot_alerts for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
