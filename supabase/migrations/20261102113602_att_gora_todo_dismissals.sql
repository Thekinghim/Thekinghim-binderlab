-- =============================================================================
-- Att göra: avbockade punkter (todo_dismissals).
--
-- Punkterna i Att göra räknas fram ur order, lager, priser och rapporter
-- (src/analytics/todos) och sparas inte. En avbockning sparar punktens nyckel
-- (todo_key, t.ex. 'refill:<automat>:<titel>') och orsakens fingerprint. Den
-- döljer punkten så länge fingerprintet är detsamma; ändras orsaken (lagret tog
-- slut, någon fyllde på, ett nytt pris) visas punkten igen. En rad per punkt och
-- organisation: att bocka av samma punkt igen skriver över raden.
--
-- `key` är en genererad kopia av todo_key. De gemensamma laddarna
-- (src/server/data/core/queries.ts, queryTodoDismissals) läser kolumnen `key`.
--
-- Behörighet: ägare och admin bockar av alla punkter. Påfyllaren ser bara
-- lagerpunkter (påfyllning och automater som inte sålt) och får bara läsa och
-- bocka av sådana; nyckeln innehåller inga belopp. Läsaren får läsa (som för
-- övriga tabeller) men inte ändra. Ändringar loggas i audit_log.
-- =============================================================================

create table public.todo_dismissals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  todo_key text not null
    check (char_length(todo_key) between 3 and 300 and todo_key ~ '^[a-z][a-z-]*:[^[:space:]]+$'),
  key text generated always as (todo_key) stored,
  fingerprint text not null check (char_length(fingerprint) between 1 and 500),
  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, todo_key)
);

-- Vem och när sätts alltid av databasen för inloggade användare.
create function private.todo_dismissals_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new.dismissed_by := v_uid;
  end if;
  if tg_op = 'INSERT' or new.fingerprint is distinct from old.fingerprint
     or new.dismissed_by is distinct from old.dismissed_by then
    new.dismissed_at := now();
  else
    new.dismissed_at := old.dismissed_at;
  end if;
  return new;
end
$$;

revoke all on function private.todo_dismissals_stamp() from public;

-- Nyckeltyperna som påfyllaren får se och bocka av.
create function private.todo_key_is_stock(p_key text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_key like 'refill:%' or p_key like 'stale-machine:%'
$$;

revoke all on function private.todo_key_is_stock(text) from public, anon;
grant execute on function private.todo_key_is_stock(text) to authenticated;

create trigger t00_forbid_org_change before update on public.todo_dismissals
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.todo_dismissals
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.todo_dismissals
  for each row execute function private.stamp_update();
create trigger t30_dismissal_stamp before insert or update on public.todo_dismissals
  for each row execute function private.todo_dismissals_stamp();
create trigger t90_audit after insert or update or delete on public.todo_dismissals
  for each row execute function private.audit();

create index todo_dismissals_org_idx on public.todo_dismissals (organization_id, dismissed_at desc);

alter table public.todo_dismissals alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------
alter table public.todo_dismissals enable row level security;
revoke all on table public.todo_dismissals from anon, authenticated;
grant select, insert, update, delete on table public.todo_dismissals to authenticated;

create policy todo_dismissals_select on public.todo_dismissals
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
    or (
      organization_id = any (array(select private.orgs_with_role('refiller')))
      and private.todo_key_is_stock(todo_key)
    )
  );

create policy todo_dismissals_insert on public.todo_dismissals
  for insert to authenticated
  with check (
    dismissed_by = (select auth.uid())
    and (
      organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
      or (
        organization_id = any (array(select private.orgs_with_role('refiller')))
        and private.todo_key_is_stock(todo_key)
      )
    )
  );

create policy todo_dismissals_update on public.todo_dismissals
  for update to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      organization_id = any (array(select private.orgs_with_role('refiller')))
      and private.todo_key_is_stock(todo_key)
    )
  )
  with check (
    dismissed_by = (select auth.uid())
    and (
      organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
      or (
        organization_id = any (array(select private.orgs_with_role('refiller')))
        and private.todo_key_is_stock(todo_key)
      )
    )
  );

create policy todo_dismissals_delete on public.todo_dismissals
  for delete to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      organization_id = any (array(select private.orgs_with_role('refiller')))
      and private.todo_key_is_stock(todo_key)
    )
  );
