-- =============================================================================
-- Tillväxt D: plan för fler automater (Butiker → Expansion → Plan).
--
-- growth_plans   En rad per organisation: målet (antal automater) och förvalen planen
--                räknar med. null = standard (automatpriset från investeringarna,
--                startlager = en månads inköp, takten som når målet på 12 månader,
--                påfyllningstiden från effektmätningen eller 45 minuter).
--
-- Behörighet: ägare och admin skriver, läsaren läser. Påfyllaren ser ingenting
-- (tillåtlistan nämner inte tabellen). Ändringar loggas i audit_log. Raden raderas inte.
-- =============================================================================

create table public.growth_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  target_machines integer not null default 20 check (target_machines between 1 and 1000),
  -- Automat inklusive installation, öre.
  machine_price_ore bigint check (machine_price_ore is null or machine_price_ore between 0 and 100000000),
  -- Startlager per automat, öre.
  start_stock_ore bigint check (start_stock_ore is null or start_stock_ore between 0 and 100000000),
  machines_per_month integer check (machines_per_month is null or machines_per_month between 1 and 50),
  refill_minutes_per_machine_week integer
    check (refill_minutes_per_machine_week is null or refill_minutes_per_machine_week between 1 and 1000),
  people integer not null default 2 check (people between 1 and 100),
  hours_per_person_week integer not null default 10 check (hours_per_person_week between 1 and 80),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

alter table public.growth_plans alter column organization_id set statistics 0;

create trigger t00_forbid_org_change before update on public.growth_plans
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.growth_plans
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.growth_plans
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.growth_plans
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.growth_plans
  for each row execute function private.forbid_delete();

alter table public.growth_plans enable row level security;
revoke all on table public.growth_plans from anon, authenticated, service_role;
grant select, insert, update on table public.growth_plans to authenticated;
grant select, insert, update on table public.growth_plans to service_role;

create policy growth_plans_select on public.growth_plans
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy growth_plans_insert on public.growth_plans
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy growth_plans_update on public.growth_plans
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
