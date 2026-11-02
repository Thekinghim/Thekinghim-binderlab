-- =============================================================================
-- 6. Inköp: suppliers, supplier_items, purchase_orders, purchase_order_lines.
-- Mottagning skapar en lagerhändelse av typen 'receipt' i centrallagret.
-- =============================================================================

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  contact_name text,
  email extensions.citext,
  phone text,
  default_lead_time_days integer check (default_lead_time_days >= 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.supplier_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  supplier_id uuid not null,
  title_id uuid not null,
  pack_size integer not null default 1 check (pack_size >= 1),
  min_order_qty integer not null default 1 check (min_order_qty >= 1),
  lead_time_days integer check (lead_time_days >= 0),
  unit_cost_ore bigint not null check (unit_cost_ore >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, supplier_id, title_id),
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  supplier_id uuid not null,
  status public.purchase_order_status not null default 'draft',
  ordered_on date,
  expected_on date,
  received_on date,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id)
    on delete restrict
);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  purchase_order_id uuid not null,
  title_id uuid not null,
  quantity integer not null check (quantity >= 1),
  unit_cost_ore bigint not null check (unit_cost_ore >= 0),
  received_quantity integer not null default 0 check (received_quantity >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, purchase_order_id) references public.purchase_orders (organization_id, id)
    on delete restrict,
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict
);

-- Mottaget antal kan bara öka. Ökningen blir en 'receipt' i centrallagret.
create function private.purchase_order_lines_receive() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_delta integer := new.received_quantity - case when tg_op = 'UPDATE' then old.received_quantity else 0 end;
  v_location uuid;
begin
  if v_delta = 0 then
    return null;
  end if;
  if v_delta < 0 then
    raise exception using
      errcode = '22023',
      message = 'Mottaget antal kan inte minska. Rätta med en lagerjustering.';
  end if;
  select l.id into v_location
  from public.stock_locations l
  where l.organization_id = new.organization_id and l.is_central;
  if v_location is null then
    raise exception using errcode = '22023', message = 'Organisationen saknar centrallager.';
  end if;
  insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
  values (new.organization_id, v_location, new.title_id, 'receipt', v_delta, 'Inleverans');
  return null;
end
$$;

create trigger t00_forbid_org_change before update on public.suppliers
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.suppliers
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.suppliers
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.suppliers
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.supplier_items
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.supplier_items
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.supplier_items
  for each row execute function private.stamp_update();

create trigger t00_forbid_org_change before update on public.purchase_orders
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.purchase_orders
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.purchase_orders
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.purchase_orders
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.purchase_order_lines
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.purchase_order_lines
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.purchase_order_lines
  for each row execute function private.stamp_update();
create trigger t50_receive after insert or update of received_quantity on public.purchase_order_lines
  for each row execute function private.purchase_order_lines_receive();
create trigger t99_forbid_delete before delete on public.purchase_order_lines
  for each row execute function private.forbid_delete();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS (inget är synligt för påfyllare)
-- -----------------------------------------------------------------------------
alter table public.suppliers enable row level security;
revoke all on table public.suppliers from anon, authenticated;
grant select, insert, update on table public.suppliers to authenticated;

create policy suppliers_select on public.suppliers
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy suppliers_insert on public.suppliers
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy suppliers_update on public.suppliers
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.supplier_items enable row level security;
revoke all on table public.supplier_items from anon, authenticated;
grant select, insert, update, delete on table public.supplier_items to authenticated;

create policy supplier_items_select on public.supplier_items
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy supplier_items_insert on public.supplier_items
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy supplier_items_update on public.supplier_items
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy supplier_items_delete on public.supplier_items
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.purchase_orders enable row level security;
revoke all on table public.purchase_orders from anon, authenticated;
grant select, insert, update on table public.purchase_orders to authenticated;

create policy purchase_orders_select on public.purchase_orders
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy purchase_orders_insert on public.purchase_orders
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy purchase_orders_update on public.purchase_orders
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.purchase_order_lines enable row level security;
revoke all on table public.purchase_order_lines from anon, authenticated;
grant select, insert, update on table public.purchase_order_lines to authenticated;

create policy purchase_order_lines_select on public.purchase_order_lines
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy purchase_order_lines_insert on public.purchase_order_lines
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy purchase_order_lines_update on public.purchase_order_lines
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

revoke all on all functions in schema private from public;
