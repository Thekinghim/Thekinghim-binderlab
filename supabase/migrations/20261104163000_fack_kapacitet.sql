-- =============================================================================
-- Fyllnadsgrad: kapacitet per titel och automat från Awish (machine_slot_capacity).
--
-- Awish listar varje fack med kanal ("A3"), vara, antal nu och kapacitet. Synken
-- (src/server/awish/slot-capacity.ts) summerar kapaciteten per titel och skriver en
-- rad per titel och automat, med facken (channels) och tiden för läsningen. En titel
-- som inte längre står i automaten tas bort. Besöksplanen fyller då till kapaciteten
-- i stället för 7 dagars försäljning, och Drift visar fyllnadsgraden.
--
-- Ingen audit-trigger: synken skriver om raderna var 10:e minut och skulle fylla
-- audit_log med brus. Raderna är en spegel av Awish, inte något användare ändrar.
--
-- Behörighet: alla roller läser (antal pack, inga belopp). Inga klientpolicyer för
-- att skriva: bara synken skriver, via serveranslutningen (databasägaren, samma som
-- skriver stock_events från Awish) som inte går genom RLS.
-- =============================================================================

create table public.machine_slot_capacity (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  title_id uuid not null,
  capacity integer not null check (capacity between 1 and 10000),
  channels text[] not null default '{}',
  synced_at timestamptz not null,
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

comment on table public.machine_slot_capacity is
  'Kapacitet (pack) och fack per automat och titel, enligt senaste läsningen från Awish.';

create trigger t00_forbid_org_change before update on public.machine_slot_capacity
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.machine_slot_capacity
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.machine_slot_capacity
  for each row execute function private.stamp_update();
-- Medvetet ingen t90_audit (se filhuvudet).

-- Som övriga tabeller (20261102160000_hardening_org_statistics.sql).
alter table public.machine_slot_capacity alter column organization_id set statistics 0;

alter table public.machine_slot_capacity enable row level security;
revoke all on table public.machine_slot_capacity from anon, authenticated;
grant select on table public.machine_slot_capacity to authenticated;
revoke truncate, references, trigger on table public.machine_slot_capacity
  from authenticated, service_role;

create policy machine_slot_capacity_select on public.machine_slot_capacity for select
  to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
