-- =============================================================================
-- Managerpaket 1–3: ansvarig per automat, tilldelning i Att göra och butikens plats.
--
-- 1. machines.responsible_user_id: vem som fyller på automaten. null = Båda (standard).
--    Måste vara medlem i organisationen med en roll som fyller på (ägare, admin,
--    påfyllare); kontrolleras av en trigger. Bara ägare och admin ändrar (machines_update).
-- 2. todo_assignments: en punkt i Att göra tilldelad en person ("Jag" / "Delägaren"),
--    eller uttryckligen Båda (assigned_to null). Ingen rad = automatens ansvariga för
--    punkter om en automat, annars Båda. En rad per punkt.
--    Samma behörighet som todo_dismissals: påfyllaren bara lagerpunkter.
-- 3. stores.latitude/longitude: valfri plats (WGS 84) för ruttordningen på besöksplanen.
--    Båda eller ingen. Adressen räcker för Google Maps-länken.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Medlem som fyller på (ägare, admin, påfyllare) i organisationen?
-- -----------------------------------------------------------------------------
create function private.is_refill_member(p_org uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  -- Bara inom en organisation som anroparen själv är medlem i (servern: auth.uid() null),
  -- så att funktionen inte kan användas för att fråga om andra organisationers medlemmar.
  -- Annars null: triggarna släpper då igenom raden och RLS nekar den (42501).
  select case
    when (select auth.uid()) is null
      or exists (
        select 1 from public.memberships me
        where me.organization_id = p_org and me.user_id = (select auth.uid())
      )
    then exists (
      select 1 from public.memberships m
      where m.organization_id = p_org and m.user_id = p_user
        and m.role in ('owner', 'admin', 'refiller')
    )
  end
$$;

revoke all on function private.is_refill_member(uuid, uuid) from public, anon;
grant execute on function private.is_refill_member(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 1. Ansvarig per automat
-- -----------------------------------------------------------------------------
alter table public.machines
  add column responsible_user_id uuid references auth.users (id) on delete set null;

comment on column public.machines.responsible_user_id is
  'Vem som fyller på automaten. null = Båda.';

create function private.machines_check_responsible() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.responsible_user_id is not null
     and (tg_op = 'INSERT' or new.responsible_user_id is distinct from old.responsible_user_id)
     and not private.is_refill_member(new.organization_id, new.responsible_user_id) then
    raise exception 'Ansvarig måste vara medlem som fyller på.' using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function private.machines_check_responsible() from public;

create trigger t40_check_responsible before insert or update of responsible_user_id
  on public.machines
  for each row execute function private.machines_check_responsible();

-- -----------------------------------------------------------------------------
-- 2. Tilldelning i Att göra
-- -----------------------------------------------------------------------------
create table public.todo_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  todo_key text not null
    check (char_length(todo_key) between 3 and 300 and todo_key ~ '^[a-z][a-z-]*:[^[:space:]]+$'),
  assigned_to uuid references auth.users (id) on delete cascade,
  assigned_by uuid references auth.users (id) on delete set null,
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, todo_key)
);

comment on table public.todo_assignments is
  'Punkt i Att göra tilldelad en person (null = Båda). Ingen rad = automatens ansvariga.';

-- Vem och när sätts av databasen; den tilldelade måste fylla på i organisationen.
create function private.todo_assignments_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new.assigned_by := v_uid;
  end if;
  if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to then
    new.assigned_at := now();
    if new.assigned_to is not null
       and not private.is_refill_member(new.organization_id, new.assigned_to) then
      raise exception 'Punkten kan bara tilldelas en medlem som fyller på.' using errcode = '22023';
    end if;
  else
    new.assigned_at := old.assigned_at;
  end if;
  return new;
end
$$;

revoke all on function private.todo_assignments_stamp() from public;

create trigger t00_forbid_org_change before update on public.todo_assignments
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.todo_assignments
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.todo_assignments
  for each row execute function private.stamp_update();
create trigger t30_assignment_stamp before insert or update on public.todo_assignments
  for each row execute function private.todo_assignments_stamp();
create trigger t90_audit after insert or update or delete on public.todo_assignments
  for each row execute function private.audit();

alter table public.todo_assignments alter column organization_id set statistics 0;

alter table public.todo_assignments enable row level security;
revoke all on table public.todo_assignments from anon, authenticated;
grant select, insert, update, delete on table public.todo_assignments to authenticated;
revoke truncate, references, trigger on table public.todo_assignments from authenticated, service_role;

create policy todo_assignments_select on public.todo_assignments
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
    or (
      organization_id = any (array(select private.orgs_with_role('refiller')))
      and private.todo_key_is_stock(todo_key)
    )
  );

create policy todo_assignments_insert on public.todo_assignments
  for insert to authenticated
  with check (
    assigned_by = (select auth.uid())
    and (
      organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
      or (
        organization_id = any (array(select private.orgs_with_role('refiller')))
        and private.todo_key_is_stock(todo_key)
      )
    )
  );

create policy todo_assignments_update on public.todo_assignments
  for update to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      organization_id = any (array(select private.orgs_with_role('refiller')))
      and private.todo_key_is_stock(todo_key)
    )
  )
  with check (
    assigned_by = (select auth.uid())
    and (
      organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
      or (
        organization_id = any (array(select private.orgs_with_role('refiller')))
        and private.todo_key_is_stock(todo_key)
      )
    )
  );

create policy todo_assignments_delete on public.todo_assignments
  for delete to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      organization_id = any (array(select private.orgs_with_role('refiller')))
      and private.todo_key_is_stock(todo_key)
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Butikens plats (valfri)
-- -----------------------------------------------------------------------------
alter table public.stores
  add column latitude double precision check (latitude between -90 and 90),
  add column longitude double precision check (longitude between -180 and 180),
  add constraint stores_location_pair check ((latitude is null) = (longitude is null));

comment on column public.stores.latitude is 'Plats för ruttordningen (WGS 84). null = okänd.';
