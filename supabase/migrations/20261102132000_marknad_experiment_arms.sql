-- =============================================================================
-- Marknad: pristestets automater i en egen tabell (price_experiment_machines)
-- i stället för uuid-listor i price_experiments.
--
-- Varför: med listor kunde databasen bara kontrollera automaterna med en trigger.
-- Med en rad per automat och arm gäller vanliga sammansatta FK:er
-- (organization_id, machine_id) → machines, så en automat i en annan
-- organisation stoppas av databasen på samma sätt som överallt annars.
-- En automat kan bara stå i en arm per test (unik på test och automat).
--
-- Befintliga rader flyttas över innan kolumnerna tas bort.
-- =============================================================================

create table public.price_experiment_machines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  experiment_id uuid not null,
  machine_id uuid not null,
  arm text not null check (arm in ('test', 'control')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, experiment_id, machine_id),
  foreign key (organization_id, experiment_id) references public.price_experiments (organization_id, id)
    on delete restrict,
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict
);

create trigger t00_forbid_org_change before update on public.price_experiment_machines
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.price_experiment_machines
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.price_experiment_machines
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.price_experiment_machines
  for each row execute function private.audit();

insert into public.price_experiment_machines (organization_id, experiment_id, machine_id, arm,
  created_at, created_by)
select e.organization_id, e.id, m.machine_id, 'test', e.created_at, e.created_by
from public.price_experiments e, unnest(e.test_machine_ids) as m(machine_id)
union all
select e.organization_id, e.id, m.machine_id, 'control', e.created_at, e.created_by
from public.price_experiments e, unnest(e.control_machine_ids) as m(machine_id);

drop trigger t50_check_machines on public.price_experiments;
drop function private.price_experiments_check_machines();
alter table public.price_experiments
  drop constraint price_experiments_arms_disjoint,
  drop column test_machine_ids,
  drop column control_machine_ids;

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS (som övriga marknadstabeller)
-- -----------------------------------------------------------------------------
alter table public.price_experiment_machines enable row level security;
revoke all on table public.price_experiment_machines from anon, authenticated;
grant select, insert, update, delete on table public.price_experiment_machines to authenticated;
revoke truncate, references, trigger on table public.price_experiment_machines
  from authenticated, service_role;
alter table public.price_experiment_machines alter column organization_id set statistics 0;

create policy price_experiment_machines_select on public.price_experiment_machines
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy price_experiment_machines_insert on public.price_experiment_machines
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy price_experiment_machines_update on public.price_experiment_machines
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy price_experiment_machines_delete on public.price_experiment_machines
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
