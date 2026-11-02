-- =============================================================================
-- 2. Platser och avtal: stores, contracts (fas 9, tom), store_agreements,
-- machines, machine_placements, machine_investments.
--
-- Datumintervall (valid_from, valid_to) är INKLUSIVA: valid_to är sista dagen
-- som gäller, null = tills vidare.
-- =============================================================================

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  address text,
  contact_name text,
  email extensions.citext,
  phone text,
  is_example boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

-- Fas 9: avtal som dokument. Skapas nu, står tom.
create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  store_id uuid not null,
  valid_from date not null,
  valid_to date,
  notice_period_days integer check (notice_period_days >= 0),
  storage_path text,
  note text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, store_id) references public.stores (organization_id, id) on delete restrict,
  check (valid_to is null or valid_to >= valid_from),
  check (storage_path is null or private.storage_path_org(storage_path) is not distinct from organization_id)
);

create table public.store_agreements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  store_id uuid not null,
  contract_id uuid,
  valid_from date not null,
  valid_to date,
  commission_bp integer check (commission_bp between 0 and 10000),
  monthly_rent_ore bigint check (monthly_rent_ore >= 0),
  commission_base public.commission_base not null default 'net_excl_vat',
  rent_proration public.rent_proration not null default 'daily',
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, store_id) references public.stores (organization_id, id) on delete restrict,
  foreign key (organization_id, contract_id) references public.contracts (organization_id, id)
    on delete set null (contract_id),
  constraint store_agreements_terms_check
    check (commission_bp is not null or monthly_rent_ore is not null),
  constraint store_agreements_range_check check (valid_to is null or valid_to >= valid_from),
  constraint store_agreements_no_overlap exclude using gist (
    organization_id with =,
    store_id with =,
    daterange(valid_from, valid_to, '[]') with &&
  )
);

create table public.machines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  serial text,
  active_from date,
  active_to date,
  is_example boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, code),
  check (active_to is null or active_from is null or active_to >= active_from)
);

create table public.machine_placements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  store_id uuid not null,
  valid_from date not null,
  valid_to date,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id) on delete restrict,
  foreign key (organization_id, store_id) references public.stores (organization_id, id) on delete restrict,
  constraint machine_placements_range_check check (valid_to is null or valid_to >= valid_from),
  constraint machine_placements_no_overlap exclude using gist (
    organization_id with =,
    machine_id with =,
    daterange(valid_from, valid_to, '[]') with &&
  )
);

create index machine_placements_store_idx on public.machine_placements (organization_id, store_id);

create table public.machine_investments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  kind public.machine_investment_kind not null,
  amount_ore bigint not null check (amount_ore >= 0),
  invested_on date not null,
  depreciation_months integer check (depreciation_months between 1 and 600),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, machine_id) references public.machines (organization_id, id) on delete restrict
);

-- -----------------------------------------------------------------------------
-- Månadsstängning för intervalltabeller (avtal och placeringar).
-- Påverkade dagar: vid nytt/raderat intervall hela intervallet. Vid ändring:
-- ändras villkoren (allt utom intervallet) räknas båda intervallen, annars bara
-- de dagar som läggs till eller tas bort (så att ett tillsvidareavtal kan
-- avslutas i en öppen månad trots att det började i en stängd).
--
-- Kontrollerna i den här migreringen är AFTER-triggers: de körs först när RLS
-- har godkänt raden. Som BEFORE-triggers (security definer) läste de en annan
-- organisations stängda månader och automatgräns innan RLS nekade, och
-- felkoden (BL004/BL019 i stället för 42501) avslöjade dem.
-- -----------------------------------------------------------------------------
create function private.guard_period_ranges() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta text[] := array[
    'id', 'valid_from', 'valid_to', 'note', 'contract_id',
    'created_at', 'created_by', 'updated_at'
  ];
  v_old datemultirange;
  v_new datemultirange;
  v_affected datemultirange;
  v_what text := case tg_table_name
    when 'store_agreements' then 'Avtalet'
    when 'machine_placements' then 'Placeringen'
    else tg_table_name
  end;
begin
  if tg_op = 'DELETE' and private.purge_allowed() then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := datemultirange(daterange(old.valid_from, old.valid_to, '[]'));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := datemultirange(daterange(new.valid_from, new.valid_to, '[]'));
  end if;

  if tg_op = 'INSERT' then
    v_affected := v_new;
  elsif tg_op = 'DELETE' then
    v_affected := v_old;
  elsif (to_jsonb(old) - v_meta) is distinct from (to_jsonb(new) - v_meta) then
    v_affected := v_old + v_new;
  else
    v_affected := (v_old - v_new) + (v_new - v_old);
  end if;

  perform private.assert_period_open(
    coalesce(new.organization_id, old.organization_id), v_affected, v_what
  );
  return null;
end
$$;

-- Automatgräns per organisation (inför fler operatörer). AFTER INSERT: den
-- nya automaten räknas med. Låset på organisationsraden tas först när RLS
-- godkänt raden, så att ingen kan låsa (eller mäta låsen på) en annan
-- organisation.
create function private.machines_check_limit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_count integer;
begin
  select o.machine_limit into v_limit
  from public.organizations o
  where o.id = new.organization_id
  for update;
  if v_limit is null then
    return null;
  end if;
  select count(*) into v_count
  from public.machines m
  where m.organization_id = new.organization_id and m.archived_at is null;
  if v_count > v_limit then
    raise exception using
      errcode = 'BL019',
      message = format('Organisationen kan ha högst %s automater.', v_limit);
  end if;
  return null;
end
$$;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create trigger t00_forbid_org_change before update on public.stores
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.stores
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.stores
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.stores
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.contracts
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.contracts
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.contracts
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.contracts
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.store_agreements
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.store_agreements
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.store_agreements
  for each row execute function private.stamp_update();
create trigger t40_period_guard after insert or update or delete on public.store_agreements
  for each row execute function private.guard_period_ranges();
create trigger t90_audit after insert or update or delete on public.store_agreements
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.store_agreements
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.machines
  for each row execute function private.forbid_org_change();
create trigger t10_check_limit after insert on public.machines
  for each row execute function private.machines_check_limit();
create trigger t20_stamp_insert before insert on public.machines
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.machines
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.machines
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.machine_placements
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.machine_placements
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.machine_placements
  for each row execute function private.stamp_update();
create trigger t40_period_guard after insert or update or delete on public.machine_placements
  for each row execute function private.guard_period_ranges();
create trigger t90_audit after insert or update or delete on public.machine_placements
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.machine_placements
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.machine_investments
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.machine_investments
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.machine_investments
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.machine_investments
  for each row execute function private.forbid_delete();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------

-- stores: tillåtlistad för påfyllare (namn, adress, kontakt).
alter table public.stores enable row level security;
revoke all on table public.stores from anon, authenticated;
grant select, insert, update on table public.stores to authenticated;

create policy stores_select on public.stores
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy stores_insert on public.stores
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy stores_update on public.stores
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.contracts enable row level security;
revoke all on table public.contracts from anon, authenticated;
grant select, insert, update on table public.contracts to authenticated;

create policy contracts_select on public.contracts
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy contracts_insert on public.contracts
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy contracts_update on public.contracts
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.store_agreements enable row level security;
revoke all on table public.store_agreements from anon, authenticated;
grant select, insert, update on table public.store_agreements to authenticated;

create policy store_agreements_select on public.store_agreements
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy store_agreements_insert on public.store_agreements
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy store_agreements_update on public.store_agreements
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- machines: tillåtlistad för påfyllare.
alter table public.machines enable row level security;
revoke all on table public.machines from anon, authenticated;
grant select, insert, update on table public.machines to authenticated;

create policy machines_select on public.machines
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy machines_insert on public.machines
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy machines_update on public.machines
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- machine_placements: tillåtlistad för påfyllare.
alter table public.machine_placements enable row level security;
revoke all on table public.machine_placements from anon, authenticated;
grant select, insert, update on table public.machine_placements to authenticated;

create policy machine_placements_select on public.machine_placements
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy machine_placements_insert on public.machine_placements
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy machine_placements_update on public.machine_placements
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.machine_investments enable row level security;
revoke all on table public.machine_investments from anon, authenticated;
grant select, insert, update on table public.machine_investments to authenticated;

create policy machine_investments_select on public.machine_investments
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy machine_investments_insert on public.machine_investments
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy machine_investments_update on public.machine_investments
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

revoke all on all functions in schema private from public;
