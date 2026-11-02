-- =============================================================================
-- 11. Senare faser (fas 8): alerts, incidents. Skapas nu, står tomma.
-- (contracts, fas 9, ligger med avtalen i 20261102100200.)
-- =============================================================================

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  severity public.alert_severity not null,
  machine_id uuid,
  store_id uuid,
  title_id uuid,
  message text,
  triggered_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete set null (machine_id),
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete set null (store_id),
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete set null (title_id),
  check (acknowledged_by is null or acknowledged_at is not null)
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  started_at timestamptz not null,
  ended_at timestamptz,
  description text,
  action_taken text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  check (ended_at is null or ended_at >= started_at)
);

create trigger t00_forbid_org_change before update on public.alerts
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.alerts
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.alerts
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.alerts
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.incidents
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.incidents
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.incidents
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.incidents
  for each row execute function private.forbid_delete();

alter table public.alerts enable row level security;
revoke all on table public.alerts from anon, authenticated;
grant select, insert, update on table public.alerts to authenticated;

create policy alerts_select on public.alerts
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy alerts_insert on public.alerts
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy alerts_update on public.alerts
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.incidents enable row level security;
revoke all on table public.incidents from anon, authenticated;
grant select, insert, update on table public.incidents to authenticated;

create policy incidents_select on public.incidents
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy incidents_insert on public.incidents
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy incidents_update on public.incidents
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
