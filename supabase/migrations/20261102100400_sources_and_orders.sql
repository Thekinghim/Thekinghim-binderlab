-- =============================================================================
-- 4. Datakällor och import: data_sources, source_machines, imports,
-- import_rows (append-only), orders.
-- =============================================================================

create table public.data_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  provider public.data_source_provider not null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  source_timezone text not null default 'Asia/Shanghai'
    check (private.is_valid_timezone(source_timezone)),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  -- Namnet på hemligheten i Supabase Vault, aldrig själva värdet.
  secret_ref text check (secret_ref ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  cursor text,
  last_synced_at timestamptz,
  status public.data_source_status not null default 'active',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name)
);

-- Koppling mellan källans automat (Awish) och vår automat. machine_id är null
-- tills någon kopplar den; okända automater stoppar inte importen.
create table public.source_machines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid not null,
  external_id text not null,
  external_device_no text,
  external_name text,
  machine_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, data_source_id, external_id),
  foreign key (organization_id, data_source_id) references public.data_sources (organization_id, id)
    on delete restrict,
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete set null (machine_id)
);

create index source_machines_unmapped_idx
  on public.source_machines (organization_id)
  where machine_id is null;

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid not null,
  trigger public.import_trigger not null,
  file_name text,
  file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text check (storage_path like organization_id::text || '/%'),
  parser_version text not null,
  mapping jsonb,
  rows_total integer not null default 0 check (rows_total >= 0),
  rows_new integer not null default 0 check (rows_new >= 0),
  rows_duplicate integer not null default 0 check (rows_duplicate >= 0),
  rows_conflict integer not null default 0 check (rows_conflict >= 0),
  rows_error integer not null default 0 check (rows_error >= 0),
  status public.import_status not null default 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, data_source_id) references public.data_sources (organization_id, id)
    on delete restrict,
  check (finished_at is null or started_at is null or finished_at >= started_at)
);

create index imports_file_sha256_idx on public.imports (organization_id, data_source_id, file_sha256);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid not null,
  external_id text not null check (char_length(external_id) between 1 and 200),
  raw_title text not null,
  title_id uuid,
  ordered_at timestamptz not null,
  -- Affärsdatum i organisationens tidszon. Räknas fram av databasen om det
  -- saknas, och kontrolleras mot ordered_at om det anges.
  business_date date not null,
  amount_ore bigint not null check (amount_ore >= 0),
  payment_method text,
  source_machine_id uuid,
  machine_id uuid,
  import_id uuid,
  source_hash text not null,
  -- Importerad efter att månaden stängts: sparas, men syns i nästa rapport.
  late_in_closed_period boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, data_source_id, external_id),
  foreign key (organization_id, data_source_id) references public.data_sources (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete set null (title_id),
  foreign key (organization_id, source_machine_id) references public.source_machines (organization_id, id)
    on delete restrict,
  foreign key (organization_id, machine_id) references public.machines (organization_id, id)
    on delete restrict,
  foreign key (organization_id, import_id) references public.imports (organization_id, id)
    on delete restrict
);

create index orders_business_date_idx on public.orders (organization_id, business_date);
create index orders_title_idx on public.orders (organization_id, title_id, business_date);
create index orders_machine_idx on public.orders (organization_id, machine_id, business_date);
create index orders_unmapped_machine_idx
  on public.orders (organization_id, source_machine_id)
  where machine_id is null;

-- Rådata per importerad rad. Dubbletter sparas inte rad för rad.
create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  import_id uuid not null,
  row_number integer not null check (row_number >= 1),
  raw jsonb not null,
  status public.import_row_status not null,
  message text,
  order_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, import_id, row_number),
  foreign key (organization_id, import_id) references public.imports (organization_id, id)
    on delete restrict,
  foreign key (organization_id, order_id) references public.orders (organization_id, id)
    on delete restrict
);

-- -----------------------------------------------------------------------------
-- Ordrar
-- -----------------------------------------------------------------------------

-- Affärsdatum i organisationens tidszon och flagga för sen import till
-- stängd månad.
create function private.orders_before_insert() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_date date;
begin
  select o.timezone into v_tz from public.organizations o where o.id = new.organization_id;
  if v_tz is null then
    -- Okänd organisation: låt FK/RLS ge felet.
    return new;
  end if;
  v_date := (new.ordered_at at time zone v_tz)::date;
  if new.business_date is null then
    new.business_date := v_date;
  elsif new.business_date <> v_date then
    raise exception using
      errcode = '22023',
      message = format(
        'business_date %s stämmer inte med ordered_at (%s i %s).',
        new.business_date, v_date, v_tz
      );
  end if;
  new.late_in_closed_period := private.is_closed_day(new.organization_id, new.business_date);
  return new;
end
$$;

-- En importerad order ändras aldrig. Undantag: titeln (koppling i kön eller
-- sammanslagning, aldrig tillbaka till null) och automaten (bara från null,
-- när en okänd källautomat kopplas).
create function private.orders_before_update() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_changed text[] := private.changed_keys(to_jsonb(old), to_jsonb(new));
begin
  if private.is_actor_anonymization(to_jsonb(old), to_jsonb(new)) then
    return new;
  end if;
  if not (v_changed <@ array['title_id', 'machine_id', 'updated_at']) then
    raise exception using
      errcode = 'BL007',
      message = 'En importerad order ändras inte.',
      detail = format('Ändrade kolumner: %s', array_to_string(v_changed, ', '));
  end if;
  if old.title_id is not null and new.title_id is null then
    raise exception using errcode = 'BL007', message = 'Orderns titel kan inte tas bort.';
  end if;
  if old.machine_id is not null and new.machine_id is distinct from old.machine_id then
    raise exception using errcode = 'BL007', message = 'Orderns automat kan inte ändras.';
  end if;
  return new;
end
$$;

create trigger t00_forbid_org_change before update on public.data_sources
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.data_sources
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.data_sources
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.data_sources
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.source_machines
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.source_machines
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.source_machines
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.source_machines
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.imports
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.imports
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.imports
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.imports
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.import_rows
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.import_rows
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.import_rows
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.import_rows
  for each row execute function private.stamp_insert();

create trigger t00_forbid_org_change before update on public.orders
  for each row execute function private.forbid_org_change();
create trigger t10_prepare before insert on public.orders
  for each row execute function private.orders_before_insert();
create trigger t10_immutable before update on public.orders
  for each row execute function private.orders_before_update();
create trigger t20_stamp_insert before insert on public.orders
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.orders
  for each row execute function private.stamp_update();
-- Bara ändringar loggas (titelkoppling och sammanslagning), inte importen.
create trigger t90_audit after update on public.orders
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.orders
  for each row execute function private.forbid_delete();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS (ingen av tabellerna är synlig för påfyllare)
-- -----------------------------------------------------------------------------
alter table public.data_sources enable row level security;
revoke all on table public.data_sources from anon, authenticated;
grant select, insert, update on table public.data_sources to authenticated;

create policy data_sources_select on public.data_sources
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy data_sources_insert on public.data_sources
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy data_sources_update on public.data_sources
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.source_machines enable row level security;
revoke all on table public.source_machines from anon, authenticated;
grant select, insert, update on table public.source_machines to authenticated;

create policy source_machines_select on public.source_machines
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy source_machines_insert on public.source_machines
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy source_machines_update on public.source_machines
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.imports enable row level security;
revoke all on table public.imports from anon, authenticated;
grant select, insert, update on table public.imports to authenticated;

create policy imports_select on public.imports
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy imports_insert on public.imports
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy imports_update on public.imports
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.import_rows enable row level security;
revoke all on table public.import_rows from anon, authenticated;
grant select, insert on table public.import_rows to authenticated;

create policy import_rows_select on public.import_rows
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy import_rows_insert on public.import_rows
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.orders enable row level security;
revoke all on table public.orders from anon, authenticated;
grant select, insert on table public.orders to authenticated;
grant update (title_id, machine_id) on table public.orders to authenticated;

create policy orders_select on public.orders
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy orders_insert on public.orders
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy orders_update on public.orders
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

revoke all on all functions in schema private from public;
