-- =============================================================================
-- 7. Mål och utgångsläge: goals, baselines.
-- Omfånget (scope) pekar på organisationen, en butik eller en automat via
-- separata kolumner med sammansatta FK:er (i stället för ett polymorft
-- scope_id), så att korsreferenser mellan organisationer stoppas av databasen.
-- =============================================================================

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  scope public.target_scope not null,
  store_id uuid,
  machine_id uuid,
  month date not null check (extract(day from month) = 1),
  metric public.goal_metric not null,
  -- Öre för revenue/profit, antal för active_machines.
  target bigint not null check (target >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint goals_scope_key unique nulls not distinct
    (organization_id, scope, store_id, machine_id, month, metric),
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict,
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  constraint goals_scope_check check (
    (scope = 'organization' and store_id is null and machine_id is null)
    or (scope = 'store' and store_id is not null and machine_id is null)
    or (scope = 'machine' and machine_id is not null and store_id is null)
  )
);

create table public.baselines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  scope public.target_scope not null,
  store_id uuid,
  machine_id uuid,
  metric public.baseline_metric not null,
  -- Heltal i enheten unit (öre, dagar, minuter eller antal). Inga flyttal.
  value bigint not null,
  unit public.baseline_unit not null,
  measured_from date,
  measured_to date,
  source text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint baselines_scope_key unique nulls not distinct
    (organization_id, scope, store_id, machine_id, metric),
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict,
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  constraint baselines_scope_check check (
    (scope = 'organization' and store_id is null and machine_id is null)
    or (scope = 'store' and store_id is not null and machine_id is null)
    or (scope = 'machine' and machine_id is not null and store_id is null)
  ),
  check (measured_to is null or measured_from is null or measured_to >= measured_from)
);

create trigger t00_forbid_org_change before update on public.goals
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.goals
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.goals
  for each row execute function private.stamp_update();

create trigger t00_forbid_org_change before update on public.baselines
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.baselines
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.baselines
  for each row execute function private.stamp_update();

alter table public.goals enable row level security;
revoke all on table public.goals from anon, authenticated;
grant select, insert, update, delete on table public.goals to authenticated;

create policy goals_select on public.goals
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy goals_insert on public.goals
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy goals_update on public.goals
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy goals_delete on public.goals
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.baselines enable row level security;
revoke all on table public.baselines from anon, authenticated;
grant select, insert, update, delete on table public.baselines to authenticated;

create policy baselines_select on public.baselines
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy baselines_insert on public.baselines
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy baselines_update on public.baselines
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy baselines_delete on public.baselines
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
